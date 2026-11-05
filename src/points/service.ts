import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/index.js';
import type { SessionUser } from '../auth/service.js';
import { CHARGE_PACKS, findPack, type ChargePack } from '../domain/points.js';
import { splitPrice } from '../domain/rules.js';
import { PaymentError, type PointsPaymentProvider } from '../payments/provider.js';

export class PointsError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface PointsConfig {
  /** チャージが有効か（ビットキャッシュ決済が接続済みか） */
  enabled: boolean;
  /** 決済後に戻すURL（BASE_URL を基点にする） */
  baseUrl: string;
  /** 運営の手数料率（%）。投稿者への還元額の算出に使う */
  feePercent: number;
}

export class PointsService {
  constructor(private db: Db, private provider: PointsPaymentProvider, private cfg: PointsConfig) {}

  /** 画面表示用のチャージパック一覧 */
  packs(): readonly ChargePack[] { return CHARGE_PACKS; }

  async balanceOf(q: Queryable, userId: string): Promise<number> {
    const r = (await q.query<{ s: string | null }>('SELECT sum(amount_pt) AS s FROM point_ledger WHERE user_id=$1', [userId])).rows[0]!;
    return Number(r.s ?? 0);
  }

  async balance(userId: string): Promise<number> { return this.balanceOf(this.db, userId); }

  /** マイページ用の残高＋履歴 */
  async summary(user: SessionUser) {
    const balance = await this.balance(user.id);
    const charges = (await this.db.query<{ pack_yen: number; amount_pt: number; status: string; created_at: string }>(
      `SELECT pack_yen, amount_pt, status, created_at FROM point_charges WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [user.id],
    )).rows;
    const ledger = (await this.db.query<{ amount_pt: number; kind: string; created_at: string }>(
      `SELECT amount_pt, kind, created_at FROM point_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`, [user.id],
    )).rows;
    return {
      balancePt: balance,
      chargeEnabled: this.cfg.enabled,
      charges: charges.map((c) => ({ packYen: c.pack_yen, amountPt: c.amount_pt, status: c.status, createdAt: c.created_at })),
      history: ledger.map((l) => ({ amountPt: l.amount_pt, kind: l.kind, createdAt: l.created_at })),
    };
  }

  // ---------------- チャージ ----------------

  /** チャージを開始する。支払額（円）はパック定義にあるものだけを受け付ける */
  async beginCharge(user: SessionUser, packYen: number): Promise<{ chargeId: string; redirectUrl: string; amountPt: number }> {
    if (!this.cfg.enabled) throw new PointsError(503, 'charge_disabled', 'ポイントのチャージは準備中です');
    const pack = findPack(packYen);
    if (!pack) throw new PointsError(400, 'invalid_pack', '選べないチャージ額です');

    const chargeId = randomUUID();
    await this.db.query(
      `INSERT INTO point_charges (id,user_id,pack_yen,amount_pt,provider,status) VALUES ($1,$2,$3,$4,$5,'pending')`,
      [chargeId, user.id, pack.yen, pack.points, this.provider.name],
    );

    let redirectUrl: string, providerRef: string;
    try {
      ({ redirectUrl, providerRef } = await this.provider.beginCharge({
        chargeId, userId: user.id, amountYen: pack.yen, returnUrl: `${this.cfg.baseUrl}/account`,
      }));
    } catch (e) {
      await this.db.query(`UPDATE point_charges SET status='failed' WHERE id=$1`, [chargeId]);
      if (e instanceof PaymentError) throw new PointsError(e.code === 'payments_disabled' ? 503 : 502, e.code, e.message);
      throw e;
    }
    await this.db.query(`UPDATE point_charges SET provider_ref=$2 WHERE id=$1`, [chargeId, providerRef]);
    return { chargeId, redirectUrl, amountPt: pack.points };
  }

  /**
   * 決済完了のWebフックを処理する。署名検証はプロバイダに委譲。
   * 既に確定済み（冪等）なら何もしない。ポイント付与は元帳の一意制約で二重計上を防ぐ。
   */
  async handleWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<{ ok: true }> {
    const v = await this.provider.verifyWebhook(rawBody, headers); // 失敗時は PaymentError

    await this.db.tx(async (q) => {
      const c = (await q.query<{ id: string; user_id: string; amount_pt: number; pack_yen: number; status: string }>(
        `SELECT id,user_id,amount_pt,pack_yen,status FROM point_charges WHERE id=$1 FOR UPDATE`, [v.chargeId],
      )).rows[0];
      if (!c) throw new PointsError(404, 'charge_not_found', '対象のチャージがありません');
      // 金額の突き合わせ（通知の改ざん・取り違え対策）
      if (v.amountYen !== c.pack_yen) throw new PointsError(400, 'amount_mismatch', '金額が一致しません');
      if (c.status === 'completed') return; // 冪等：二重通知は無視
      if (v.status !== 'completed') {
        await q.query(`UPDATE point_charges SET status='failed' WHERE id=$1`, [c.id]);
        return;
      }
      await q.query(`UPDATE point_charges SET status='completed', completed_at=now(), provider_ref=$2 WHERE id=$1`, [c.id, v.providerRef]);
      // ref_id=charge の一意制約で、同一チャージの二重付与を防ぐ
      await q.query(`INSERT INTO point_ledger (id,user_id,amount_pt,kind,ref_id) VALUES ($1,$2,$3,'charge',$4)`,
        [randomUUID(), c.user_id, c.amount_pt, c.id]);
    });
    return { ok: true };
  }

  // ---------------- 消費（有料口コミの閲覧） ----------------

  /** 有料口コミをポイントで解放する。価格はサーバーが口コミから決める。
   *  読者はポイントを消費し、投稿者には販売価格の90%が「円」残高（ledger_entries）に入る。 */
  async unlockReview(user: SessionUser, reviewId: string): Promise<{ unlockId: string; spentPt: number; balancePt: number }> {
    const review = (await this.db.query<{ author_id: string; price_yen: number | null; listing_kind: string; status: string }>(
      'SELECT author_id, price_yen, listing_kind, status FROM reviews WHERE id=$1', [reviewId],
    )).rows[0];
    if (!review || review.status !== 'published') throw new PointsError(404, 'not_found', '口コミが見つかりません');
    if (review.listing_kind !== 'paid' || !review.price_yen) throw new PointsError(400, 'not_for_sale', 'この口コミは無料で読めます');
    if (review.author_id === user.id) throw new PointsError(400, 'own_review', '自分の口コミは解放不要です');

    const costPt = review.price_yen; // 1pt = 1円相当で消費
    // 投稿者の受け取り（円）。手数料率は購入系と同じ splitPrice を使う
    const { authorNetYen } = splitPrice(review.price_yen, this.cfg.feePercent);
    const authorId = review.author_id;

    return this.db.tx(async (q) => {
      // 同一ユーザーの並行解放を直列化し、残高チェックと消費を原子的に行う
      await q.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);

      // 既に解放済みなら二重消費しない（冪等）
      const existing = (await q.query<{ id: string }>('SELECT id FROM review_unlocks WHERE review_id=$1 AND user_id=$2', [reviewId, user.id])).rows[0];
      if (existing) {
        return { unlockId: existing.id, spentPt: 0, balancePt: await this.balanceOf(q, user.id) };
      }
      // 既に「円」で購入済みの口コミは、閲覧権があるのでポイント消費も投稿者への二重計上もしない
      const boughtAlready = await q.query('SELECT 1 FROM purchases WHERE review_id=$1 AND buyer_id=$2 AND status=\'completed\'', [reviewId, user.id]);
      if (boughtAlready.rowCount > 0) {
        return { unlockId: '', spentPt: 0, balancePt: await this.balanceOf(q, user.id) };
      }

      const balance = await this.balanceOf(q, user.id);
      if (balance < costPt) throw new PointsError(402, 'insufficient_points', 'ポイントが足りません。チャージしてください');

      const unlockId = randomUUID();
      try {
        await q.query('INSERT INTO review_unlocks (id,review_id,user_id,spent_pt) VALUES ($1,$2,$3,$4)', [unlockId, reviewId, user.id, costPt]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new PointsError(409, 'already_unlocked', 'すでに解放済みです');
        throw e;
      }
      // 読者のポイントを消費
      await q.query(`INSERT INTO point_ledger (id,user_id,amount_pt,kind,ref_id) VALUES ($1,$2,$3,'spend',$4)`, [randomUUID(), user.id, -costPt, unlockId]);
      // 投稿者へ「円」で還元（既存の残高・出金の仕組みをそのまま使う）。
      // ref_id=unlockId・kind='sale' の一意制約で、同一解放の二重計上を防ぐ。
      await q.query(`INSERT INTO ledger_entries (id,user_id,amount_yen,kind,ref_id) VALUES ($1,$2,$3,'sale',$4)`, [randomUUID(), authorId, authorNetYen, unlockId]);
      return { unlockId, spentPt: costPt, balancePt: balance - costPt };
    });
  }

  /** ある口コミ群について、ユーザーが解放済みのIDの集合を返す（本文の出し分けに使う） */
  async unlockedReviewIds(userId: string, reviewIds: string[]): Promise<Set<string>> {
    if (reviewIds.length === 0) return new Set();
    const rows = (await this.db.query<{ review_id: string }>(
      `SELECT review_id FROM review_unlocks WHERE user_id=$1 AND review_id = ANY($2)`, [userId, reviewIds],
    )).rows;
    return new Set(rows.map((r) => r.review_id));
  }

  async hasUnlocked(userId: string, reviewId: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM review_unlocks WHERE review_id=$1 AND user_id=$2', [reviewId, userId]);
    return r.rowCount > 0;
  }
}
