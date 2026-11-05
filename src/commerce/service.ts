import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/index.js';
import type { SessionUser } from '../auth/service.js';
import { splitPrice } from '../domain/rules.js';
import { PaymentError, type PaymentProvider } from '../payments/provider.js';

export class CommerceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface CommerceConfig { feePercent: number; minPayoutYen: number; refundWindowHours: number; payoutsEnabled: boolean }

export class CommerceService {
  constructor(private db: Db, private payments: PaymentProvider, private cfg: CommerceConfig) {}

  // ---------------- 購入 ----------------

  /** 有料口コミを購入する。金額は口コミの価格から決め、クライアントの値は使わない */
  async purchase(buyer: SessionUser, reviewId: string): Promise<{ purchaseId: string; priceYen: number }> {
    const review = (await this.db.query<{ author_id: string; price_yen: number | null; listing_kind: string; status: string }>(
      'SELECT author_id, price_yen, listing_kind, status FROM reviews WHERE id=$1', [reviewId],
    )).rows[0];
    if (!review || review.status !== 'published') throw new CommerceError(404, 'not_found', '口コミが見つかりません');
    if (review.listing_kind !== 'paid' || !review.price_yen) throw new CommerceError(400, 'not_for_sale', 'この口コミは無料で読めます');
    if (review.author_id === buyer.id) throw new CommerceError(400, 'own_review', '自分の口コミは購入できません');

    const { feeYen, authorNetYen } = splitPrice(review.price_yen, this.cfg.feePercent);
    const purchaseId = randomUUID();

    // 1) 決済中として先に確保する。二重クリック・並行リクエストは一意制約で弾かれ、二重課金にならない
    try {
      await this.db.query(
        `INSERT INTO purchases (id,review_id,buyer_id,price_yen,fee_yen,author_net_yen,status) VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [purchaseId, reviewId, buyer.id, review.price_yen, feeYen, authorNetYen],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new CommerceError(409, 'already_purchased', 'すでに購入済みか、決済処理中です');
      throw e;
    }

    // 2) 決済。失敗したら購入を失敗として記録し、何も付与しない
    let ref: string;
    try {
      ({ ref } = await this.payments.charge({
        buyerId: buyer.id, amountYen: review.price_yen, description: 'Hodoku 口コミ', idempotencyKey: purchaseId,
      }));
    } catch (e) {
      await this.db.query(`UPDATE purchases SET status='failed' WHERE id=$1`, [purchaseId]);
      if (e instanceof PaymentError) {
        const status = e.code === 'payments_disabled' ? 503 : e.code === 'declined' ? 402 : 502;
        throw new CommerceError(status, e.code, e.message);
      }
      throw e;
    }

    // 3) 購入確定と、投稿者への売上計上を同じトランザクションで行う
    try {
      await this.db.tx(async (q) => {
        await q.query(`UPDATE purchases SET status='completed', payment_ref=$2 WHERE id=$1 AND status='pending'`, [purchaseId, ref]);
        await q.query(
          `INSERT INTO ledger_entries (id,user_id,amount_yen,kind,ref_id) VALUES ($1,$2,$3,'sale',$4)`,
          [randomUUID(), review.author_id, authorNetYen, purchaseId],
        );
      });
    } catch (e) {
      // 課金済みなのに記録できなかった場合は、自動で返金してから失敗として扱う
      await this.payments.refund(ref, review.price_yen).catch(() => undefined);
      await this.db.query(`UPDATE purchases SET status='failed', payment_ref=$2 WHERE id=$1`, [purchaseId, ref]);
      throw e;
    }
    return { purchaseId, priceYen: review.price_yen };
  }

  async myPurchases(user: SessionUser) {
    const rows = (await this.db.query<{
      id: string; review_id: string; price_yen: number; status: string; created_at: string; therapist_name: string; therapist_slug: string; shop_name: string; author_nickname: string;
      refund_status: string | null;
    }>(
      `SELECT p.id, p.review_id, p.price_yen, p.status, p.created_at, th.name AS therapist_name, th.slug AS therapist_slug, s.name AS shop_name, u.nickname AS author_nickname,
         (SELECT rr.status FROM refund_requests rr WHERE rr.purchase_id=p.id ORDER BY rr.created_at DESC LIMIT 1) AS refund_status
       FROM purchases p JOIN reviews r ON r.id=p.review_id JOIN therapists th ON th.id=r.therapist_id
       JOIN shops s ON s.id=th.shop_id JOIN users u ON u.id=r.author_id
       WHERE p.buyer_id=$1 AND p.status IN ('completed','refunded') ORDER BY p.created_at DESC`, [user.id],
    )).rows;
    const windowMs = this.cfg.refundWindowHours * 3_600_000;
    return rows.map((r) => ({
      id: r.id, reviewId: r.review_id, priceYen: r.price_yen, status: r.status, createdAt: r.created_at,
      therapistName: r.therapist_name, therapistSlug: r.therapist_slug, shopName: r.shop_name, authorNickname: r.author_nickname, refundStatus: r.refund_status,
      canRequestRefund: r.status === 'completed' && r.refund_status !== 'open' && Date.now() - new Date(r.created_at).getTime() <= windowMs,
    }));
  }

  // ---------------- 返金 ----------------

  async requestRefund(buyer: SessionUser, purchaseId: string, reason: string): Promise<{ requestId: string }> {
    const p = (await this.db.query<{ buyer_id: string; status: string; created_at: string }>(
      'SELECT buyer_id,status,created_at FROM purchases WHERE id=$1', [purchaseId],
    )).rows[0];
    // 他人の購入IDを探れないよう、存在しない場合と同じ応答にする
    if (!p || p.buyer_id !== buyer.id) throw new CommerceError(404, 'not_found', '購入が見つかりません');
    if (p.status !== 'completed') throw new CommerceError(409, 'not_refundable', 'この購入は返金を申請できません');
    if (Date.now() - new Date(p.created_at).getTime() > this.cfg.refundWindowHours * 3_600_000) {
      throw new CommerceError(409, 'window_closed', `返金を申請できるのは購入後${this.cfg.refundWindowHours}時間以内です`);
    }
    const id = randomUUID();
    try {
      await this.db.query('INSERT INTO refund_requests (id,purchase_id,reason) VALUES ($1,$2,$3)', [id, purchaseId, reason.trim().slice(0, 500)]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new CommerceError(409, 'already_requested', 'すでに返金を申請しています');
      throw e;
    }
    return { requestId: id };
  }

  async refundQueue() {
    const rows = (await this.db.query<{ id: string; reason: string; created_at: string; price_yen: number; purchase_id: string; buyer: string; author: string; body: string }>(
      `SELECT rr.id, rr.reason, rr.created_at, p.price_yen, p.id AS purchase_id, b.nickname AS buyer, a.nickname AS author, r.body
       FROM refund_requests rr JOIN purchases p ON p.id=rr.purchase_id JOIN reviews r ON r.id=p.review_id
       JOIN users b ON b.id=p.buyer_id JOIN users a ON a.id=r.author_id
       WHERE rr.status='open' ORDER BY rr.created_at`,
    )).rows;
    return rows.map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at, priceYen: r.price_yen, purchaseId: r.purchase_id, buyer: r.buyer, author: r.author, body: r.body }));
  }

  /** 返金の可否を決める。承認時は決済の返金→購入を返金済みに→投稿者の売上を差し引く、を一括で行う */
  async decideRefund(staff: SessionUser, requestId: string, decision: 'approve' | 'deny'): Promise<{ status: string }> {
    return this.db.tx(async (q: Queryable) => {
      const rr = (await q.query<{ purchase_id: string; status: string }>('SELECT purchase_id,status FROM refund_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
      if (!rr) throw new CommerceError(404, 'not_found', '申請が見つかりません');
      if (rr.status !== 'open') throw new CommerceError(409, 'already_decided', 'この申請はすでに処理済みです');

      if (decision === 'deny') {
        await q.query(`UPDATE refund_requests SET status='denied', decided_by=$2, decided_at=now() WHERE id=$1`, [requestId, staff.id]);
        await q.query(`INSERT INTO audit_log (actor_id,action,target) VALUES ($1,'refund.deny',$2)`, [staff.id, requestId]);
        return { status: 'denied' };
      }

      const p = (await q.query<{ id: string; status: string; price_yen: number; author_net_yen: number; payment_ref: string | null; author_id: string }>(
        `SELECT p.id,p.status,p.price_yen,p.author_net_yen,p.payment_ref,r.author_id FROM purchases p JOIN reviews r ON r.id=p.review_id WHERE p.id=$1 FOR UPDATE OF p`, [rr.purchase_id],
      )).rows[0]!;
      if (p.status !== 'completed' || !p.payment_ref) throw new CommerceError(409, 'not_refundable', 'この購入は返金できません');

      // 決済側の返金に失敗したら、この例外でトランザクション全体がロールバックされ、何も変わらない
      try {
        await this.payments.refund(p.payment_ref, p.price_yen);
      } catch (e) {
        if (e instanceof PaymentError) throw new CommerceError(502, e.code, e.message);
        throw e;
      }
      await q.query(`UPDATE purchases SET status='refunded', refunded_at=now(), refund_reason='返金申請の承認' WHERE id=$1`, [p.id]);
      await q.query(`UPDATE refund_requests SET status='approved', decided_by=$2, decided_at=now() WHERE id=$1`, [requestId, staff.id]);
      await q.query(`INSERT INTO ledger_entries (id,user_id,amount_yen,kind,ref_id) VALUES ($1,$2,$3,'refund_clawback',$4)`, [randomUUID(), p.author_id, -p.author_net_yen, p.id]);
      await q.query(`INSERT INTO audit_log (actor_id,action,target,detail) VALUES ($1,'refund.approve',$2,$3)`, [staff.id, requestId, JSON.stringify({ purchaseId: p.id, priceYen: p.price_yen })]);
      return { status: 'approved' };
    });
  }

  // ---------------- 残高・出金 ----------------

  async balanceOf(q: Queryable, userId: string): Promise<number> {
    const r = (await q.query<{ s: string | null }>('SELECT sum(amount_yen) AS s FROM ledger_entries WHERE user_id=$1', [userId])).rows[0]!;
    return Number(r.s ?? 0);
  }

  async summary(user: SessionUser) {
    const month = (await this.db.query<{ n: string; net: string | null; fee: string | null }>(
      `SELECT count(*) AS n, sum(p.author_net_yen) AS net, sum(p.fee_yen) AS fee
       FROM purchases p JOIN reviews r ON r.id=p.review_id
       WHERE r.author_id=$1 AND p.status='completed' AND p.created_at >= date_trunc('month', now())`, [user.id],
    )).rows[0]!;
    const bought = (await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM purchases WHERE buyer_id=$1 AND status='completed'`, [user.id])).rows[0]!;
    const open = (await this.db.query<{ id: string; amount_yen: number }>(`SELECT id,amount_yen FROM payout_requests WHERE user_id=$1 AND status='open'`, [user.id])).rows[0];
    const history = (await this.db.query<{ amount_yen: number; status: string; created_at: string }>(
      `SELECT amount_yen,status,created_at FROM payout_requests WHERE user_id=$1 AND status<>'open' ORDER BY created_at DESC LIMIT 10`, [user.id])).rows;
    return {
      balanceYen: await this.balanceOf(this.db, user.id),
      monthSalesCount: Number(month.n), monthNetYen: Number(month.net ?? 0), monthFeeYen: Number(month.fee ?? 0),
      boughtCount: Number(bought.n), minPayoutYen: this.cfg.minPayoutYen, feePercent: this.cfg.feePercent, payoutsEnabled: this.cfg.payoutsEnabled,
      openPayout: open ? { id: open.id, amountYen: open.amount_yen } : null,
      payoutHistory: history.map((h) => ({ amountYen: h.amount_yen, status: h.status, createdAt: h.created_at })),
    };
  }

  /** 残高の全額を出金申請する。申請と同時に残高から引き当て、二重出金を防ぐ */
  async requestPayout(user: SessionUser): Promise<{ id: string; amountYen: number }> {
    if (!this.cfg.payoutsEnabled) throw new CommerceError(503, 'payouts_disabled', '出金の受付は準備中です');
    return this.db.tx(async (q) => {
      // 同一ユーザーの並行申請を直列化
      await q.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const balance = await this.balanceOf(q, user.id);
      if (balance < this.cfg.minPayoutYen) {
        throw new CommerceError(400, 'below_minimum', `出金できるのは残高が${this.cfg.minPayoutYen.toLocaleString('ja-JP')}円以上のときです`);
      }
      const id = randomUUID();
      try {
        await q.query('INSERT INTO payout_requests (id,user_id,amount_yen) VALUES ($1,$2,$3)', [id, user.id, balance]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new CommerceError(409, 'already_requested', 'すでに出金を申請しています');
        throw e;
      }
      await q.query(`INSERT INTO ledger_entries (id,user_id,amount_yen,kind,ref_id) VALUES ($1,$2,$3,'payout',$4)`, [randomUUID(), user.id, -balance, id]);
      return { id, amountYen: balance };
    });
  }

  async payoutQueue() {
    const rows = (await this.db.query<{ id: string; amount_yen: number; created_at: string; nickname: string; email: string }>(
      `SELECT pr.id, pr.amount_yen, pr.created_at, u.nickname, u.email FROM payout_requests pr JOIN users u ON u.id=pr.user_id WHERE pr.status='open' ORDER BY pr.created_at`,
    )).rows;
    return rows.map((r) => ({ id: r.id, amountYen: r.amount_yen, createdAt: r.created_at, nickname: r.nickname, email: r.email }));
  }

  /** 出金を実行済み(paid)にするか、却下(denied)して残高に戻す */
  async decidePayout(admin: SessionUser, requestId: string, decision: 'paid' | 'denied'): Promise<{ status: string }> {
    return this.db.tx(async (q) => {
      const pr = (await q.query<{ user_id: string; amount_yen: number; status: string }>('SELECT user_id,amount_yen,status FROM payout_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
      if (!pr) throw new CommerceError(404, 'not_found', '申請が見つかりません');
      if (pr.status !== 'open') throw new CommerceError(409, 'already_decided', 'この申請はすでに処理済みです');
      await q.query('UPDATE payout_requests SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1', [requestId, decision, admin.id]);
      if (decision === 'denied') {
        await q.query(`INSERT INTO ledger_entries (id,user_id,amount_yen,kind,ref_id) VALUES ($1,$2,$3,'payout_reversal',$4)`, [randomUUID(), pr.user_id, pr.amount_yen, requestId]);
      }
      await q.query(`INSERT INTO audit_log (actor_id,action,target,detail) VALUES ($1,$2,$3,$4)`, [admin.id, `payout.${decision}`, requestId, JSON.stringify({ amountYen: pr.amount_yen })]);
      return { status: decision };
    });
  }

  // ---------------- 通報 ----------------

  async reportQueue() {
    const rows = (await this.db.query<{ id: string; reason: string; created_at: string; review_id: string; body: string; reporter: string | null; author: string }>(
      `SELECT rp.id, rp.reason, rp.created_at, rp.review_id, r.body, rb.nickname AS reporter, a.nickname AS author
       FROM reports rp JOIN reviews r ON r.id=rp.review_id JOIN users a ON a.id=r.author_id LEFT JOIN users rb ON rb.id=rp.reporter_id
       WHERE rp.status='open' ORDER BY rp.created_at`,
    )).rows;
    return rows.map((r) => ({ id: r.id, reason: r.reason, createdAt: r.created_at, reviewId: r.review_id, body: r.body, reporter: r.reporter, author: r.author }));
  }

  async closeReport(staff: SessionUser, reportId: string, unpublish: boolean): Promise<void> {
    await this.db.tx(async (q) => {
      const r = (await q.query<{ review_id: string; status: string }>('SELECT review_id,status FROM reports WHERE id=$1 FOR UPDATE', [reportId])).rows[0];
      if (!r) throw new CommerceError(404, 'not_found', '通報が見つかりません');
      if (r.status !== 'open') throw new CommerceError(409, 'already_decided', 'この通報はすでに処理済みです');
      await q.query(`UPDATE reports SET status='closed' WHERE id=$1`, [reportId]);
      if (unpublish) await q.query(`UPDATE reviews SET status='rejected', moderated_by=$2, moderated_at=now(), moderation_reason='通報により非公開' WHERE id=$1`, [r.review_id, staff.id]);
      await q.query(`INSERT INTO audit_log (actor_id,action,target,detail) VALUES ($1,'report.close',$2,$3)`, [staff.id, reportId, JSON.stringify({ unpublish })]);
    });
  }
}
