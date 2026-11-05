import { randomUUID } from 'node:crypto';
import type { Db, Queryable } from '../db/index.js';
import type { SessionUser } from '../auth/service.js';
import {
  MAX_BODY_CHARS, MIN_PAID_BODY_CHARS, PRICE_TIERS, autoFlags, charLength, hasMinorHint, paidIneligibleReasons,
  previewOf, similarityPercent, SIMILARITY_FLAG_THRESHOLD,
} from '../domain/rules.js';
import { trustLevel } from '../domain/trust.js';

export class ReviewError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: string[]) { super(message); }
}

export interface NewReview {
  therapistSlug: string;
  visitedWhen: 'this_month' | 'last_month' | 'few_months_ago';
  courseMinutes: 60 | 90 | 120;
  ngPrecheck: 'on_booking' | 'on_site' | 'none';
  totalMatched: 'matched' | 'slightly_off' | 'very_off';
  scoreCare: number; scoreComfort: number; scorePunctual: number;
  giftReceived: boolean;
  body: string;
  listing: { kind: 'free' } | { kind: 'paid'; priceYen: number };
}

interface ReviewRow {
  id: string; author_id: string; author_nickname: string; author_posts: string;
  visited_when: string; course_minutes: number; ng_precheck: string; total_matched: string;
  gift_received: boolean; body: string; listing_kind: 'free' | 'paid'; price_yen: number | null;
  usage_verified: boolean; status: string; auto_flags: string[]; similarity_score: string | null;
  helpful_count: number; published_at: string | null; created_at: string; purchased: boolean;
}

export type ReviewTrust = 'verified' | 'unverified' | 'flagged';

/** 画面に返す口コミ。全文(body)は閲覧権限があるときだけ入れる */
export interface ReviewView {
  id: string; authorNickname: string; authorPostCount: number;
  visitedWhen: string; courseMinutes: number; ngPrecheck: string; totalMatched: string; giftReceived: boolean;
  kind: 'free' | 'paid'; priceYen: number | null; trust: ReviewTrust;
  helpfulCount: number; publishedAt: string | null;
  locked: boolean; purchased: boolean; isMine: boolean;
  /** locked=true のときは冒頭のみ。false のときは全文 */
  body: string;
}

export function canReadFull(r: { listing_kind: string; author_id: string; purchased: boolean }, viewer: SessionUser | null): boolean {
  if (r.listing_kind === 'free') return true;
  if (!viewer) return false;
  return viewer.id === r.author_id || viewer.role === 'moderator' || viewer.role === 'admin' || r.purchased;
}

export function toView(r: ReviewRow, viewer: SessionUser | null): ReviewView {
  const full = canReadFull(r, viewer);
  const flags = Array.isArray(r.auto_flags) ? r.auto_flags : [];
  const trust: ReviewTrust = flags.includes('similar') ? 'flagged' : r.usage_verified ? 'verified' : 'unverified';
  return {
    id: r.id, authorNickname: r.author_nickname, authorPostCount: Number(r.author_posts),
    visitedWhen: r.visited_when, courseMinutes: r.course_minutes, ngPrecheck: r.ng_precheck, totalMatched: r.total_matched,
    giftReceived: r.gift_received, kind: r.listing_kind, priceYen: r.price_yen, trust,
    helpfulCount: r.helpful_count, publishedAt: r.published_at,
    locked: !full, purchased: r.purchased, isMine: viewer?.id === r.author_id,
    body: full ? r.body : previewOf(r.body),
  };
}

const REVIEW_SELECT = `
  SELECT r.id, r.author_id, u.nickname AS author_nickname,
    (SELECT count(*) FROM reviews x WHERE x.author_id = r.author_id AND x.status='published') AS author_posts,
    r.visited_when, r.course_minutes, r.ng_precheck, r.total_matched, r.gift_received, r.body, r.listing_kind, r.price_yen,
    r.usage_verified, r.status, r.auto_flags, r.similarity_score, r.helpful_count, r.published_at, r.created_at,
    (EXISTS (SELECT 1 FROM purchases p WHERE p.review_id = r.id AND p.buyer_id = $1 AND p.status='completed')
     OR EXISTS (SELECT 1 FROM review_unlocks ru WHERE ru.review_id = r.id AND ru.user_id = $1)) AS purchased
  FROM reviews r JOIN users u ON u.id = r.author_id`;

export class ReviewService {
  constructor(private db: Db) {}

  async submit(author: SessionUser, input: NewReview): Promise<{ id: string; flags: string[]; status: 'pending' }> {
    const bodyChars = charLength(input.body);
    if (bodyChars > MAX_BODY_CHARS) throw new ReviewError(400, 'body_too_long', `本文は${MAX_BODY_CHARS}字までです`);
    if (hasMinorHint(input.body)) {
      throw new ReviewError(400, 'forbidden_content', '18歳未満を連想させる表現は投稿できません。内容を見直してください');
    }
    if (input.listing.kind === 'paid') {
      if (!PRICE_TIERS.includes(input.listing.priceYen as (typeof PRICE_TIERS)[number])) throw new ReviewError(400, 'invalid_price', '選べない価格です');
      if (input.giftReceived) throw new ReviewError(400, 'paid_not_allowed', '店舗から特典を受け取った口コミは有料で販売できません。無料で公開してください');
      if (bodyChars < MIN_PAID_BODY_CHARS) throw new ReviewError(400, 'paid_not_allowed', `有料で販売するには本文が${MIN_PAID_BODY_CHARS}字以上必要です（いま${bodyChars}字）`);
    }

    const t = (await this.db.query<{ id: string }>(
      `SELECT t.id FROM therapists t JOIN shops s ON s.id=t.shop_id WHERE t.slug=$1 AND t.published AND s.published`, [input.therapistSlug],
    )).rows[0];
    if (!t) throw new ReviewError(404, 'not_found', '担当者が見つかりません');

    // 連続投稿の抑止：同じ担当者には30日に1件、1日の合計は3件まで
    const recent = (await this.db.query<{ same: string; day: string }>(
      `SELECT count(*) FILTER (WHERE therapist_id=$2 AND created_at > now() - interval '30 days' AND status <> 'rejected') AS same,
              count(*) FILTER (WHERE created_at > now() - interval '1 day') AS day
       FROM reviews WHERE author_id=$1`, [author.id, t.id],
    )).rows[0]!;
    if (Number(recent.same) > 0) throw new ReviewError(409, 'duplicate_recent', 'この担当者には、30日以内にすでに口コミを投稿しています');
    if (Number(recent.day) >= 3) throw new ReviewError(429, 'daily_limit', '1日に投稿できる口コミは3件までです');

    const others = (await this.db.query<{ body: string }>(
      `SELECT body FROM reviews WHERE status <> 'rejected' AND body <> '' ORDER BY created_at DESC LIMIT 300`,
    )).rows;
    const similarity = others.reduce((m, o) => Math.max(m, similarityPercent(input.body, o.body)), 0);
    const flags = autoFlags(input.body, { similarity, giftReceived: input.giftReceived });

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,
         score_care,score_comfort,score_punctual,gift_received,body,listing_kind,price_yen,auto_flags,similarity_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, author.id, t.id, input.visitedWhen, input.courseMinutes, input.ngPrecheck, input.totalMatched,
        input.scoreCare, input.scoreComfort, input.scorePunctual, input.giftReceived, input.body,
        input.listing.kind, input.listing.kind === 'paid' ? input.listing.priceYen : null, JSON.stringify(flags), similarity],
    );
    return { id, flags, status: 'pending' };
  }

  /** 担当者ページ用：公開済みの口コミと集計。集計は「要確認（類似）」の投稿を除く */
  async listForTherapist(slug: string, viewer: SessionUser | null) {
    const th = (await this.db.query<{ id: string; name: string; bio: string; texture: string; shop_slug: string; shop_name: string }>(
      `SELECT t.id, t.name, t.bio, t.texture, s.slug AS shop_slug, s.name AS shop_name
       FROM therapists t JOIN shops s ON s.id=t.shop_id WHERE t.slug=$1 AND t.published AND s.published`, [slug],
    )).rows[0];
    if (!th) return null;

    const rows = (await this.db.query<ReviewRow>(
      `${REVIEW_SELECT} WHERE r.therapist_id=$2 AND r.status='published' ORDER BY r.published_at DESC`,
      [viewer?.id ?? '00000000-0000-0000-0000-000000000000', th.id],
    )).rows;

    const agg = (await this.db.query<{ care: string | null; comfort: string | null; punctual: string | null; n: string; v: string; total_ok: string | null }>(
      `SELECT avg(score_care) AS care, avg(score_comfort) AS comfort, avg(score_punctual) AS punctual,
              count(*) AS n, count(*) FILTER (WHERE usage_verified) AS v,
              avg(CASE total_matched WHEN 'matched' THEN 5 WHEN 'slightly_off' THEN 3 ELSE 1 END) AS total_ok
       FROM reviews WHERE therapist_id=$1 AND status='published' AND NOT (auto_flags ? 'similar')`, [th.id],
    )).rows[0]!;
    const total = (await this.db.query<{ n: string; v: string; paid: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE usage_verified) AS v, count(*) FILTER (WHERE listing_kind='paid') AS paid
       FROM reviews WHERE therapist_id=$1 AND status='published'`, [th.id],
    )).rows[0]!;
    const r1 = (x: string | null) => (x === null ? null : Math.round(Number(x) * 10) / 10);
    return {
      therapist: { slug, name: th.name, bio: th.bio, texture: th.texture, shopSlug: th.shop_slug, shopName: th.shop_name },
      summary: {
        count: Number(total.n), verifiedCount: Number(total.v), paidCount: Number(total.paid),
        trust: trustLevel(Number(total.n), Number(total.v)),
        scores: { care: r1(agg.care), comfort: r1(agg.comfort), punctual: r1(agg.punctual), totalClarity: r1(agg.total_ok) },
        scoredCount: Number(agg.n),
      },
      reviews: rows.map((r) => toView(r, viewer)),
    };
  }

  async mine(user: SessionUser) {
    const rows = (await this.db.query<ReviewRow & { therapist_name: string; therapist_slug: string; shop_name: string; moderation_reason: string | null; sold_count: string; sold_net: string | null }>(
      `${REVIEW_SELECT.replace('FROM reviews r', `, th.name AS therapist_name, th.slug AS therapist_slug, s.name AS shop_name, r.moderation_reason,
         (SELECT count(*) FROM purchases p WHERE p.review_id=r.id AND p.status='completed') AS sold_count,
         (SELECT sum(p.author_net_yen) FROM purchases p WHERE p.review_id=r.id AND p.status='completed') AS sold_net FROM reviews r`)}
       JOIN therapists th ON th.id=r.therapist_id JOIN shops s ON s.id=th.shop_id
       WHERE r.author_id=$1 ORDER BY r.created_at DESC`, [user.id],
    )).rows;
    return rows.map((r) => ({ ...toView(r, user), status: r.status, therapistName: r.therapist_name, therapistSlug: r.therapist_slug, shopName: r.shop_name, reason: r.moderation_reason, createdAt: r.created_at, soldCount: Number(r.sold_count), soldNetYen: Number(r.sold_net ?? 0) }));
  }

  async toggleHelpful(user: SessionUser, reviewId: string): Promise<{ helpful: boolean; count: number }> {
    return this.db.tx(async (q: Queryable) => {
      const r = (await q.query<{ author_id: string; status: string }>('SELECT author_id,status FROM reviews WHERE id=$1 FOR UPDATE', [reviewId])).rows[0];
      if (!r || r.status !== 'published') throw new ReviewError(404, 'not_found', '口コミが見つかりません');
      if (r.author_id === user.id) throw new ReviewError(400, 'own_review', '自分の口コミには押せません');
      const del = await q.query('DELETE FROM review_helpful_votes WHERE review_id=$1 AND user_id=$2', [reviewId, user.id]);
      let helpful: boolean;
      if (del.rowCount > 0) {
        await q.query('UPDATE reviews SET helpful_count = helpful_count - 1 WHERE id=$1', [reviewId]);
        helpful = false;
      } else {
        await q.query('INSERT INTO review_helpful_votes (review_id,user_id) VALUES ($1,$2)', [reviewId, user.id]);
        await q.query('UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id=$1', [reviewId]);
        helpful = true;
      }
      const c = (await q.query<{ helpful_count: number }>('SELECT helpful_count FROM reviews WHERE id=$1', [reviewId])).rows[0]!;
      return { helpful, count: c.helpful_count };
    });
  }

  async report(user: SessionUser, reviewId: string, reason: string): Promise<void> {
    const r = (await this.db.query('SELECT 1 FROM reviews WHERE id=$1 AND status=\'published\'', [reviewId]));
    if (r.rowCount === 0) throw new ReviewError(404, 'not_found', '口コミが見つかりません');
    await this.db.query('INSERT INTO reports (id,review_id,reporter_id,reason) VALUES ($1,$2,$3,$4)', [randomUUID(), reviewId, user.id, reason.slice(0, 500)]);
  }

  // ---------------- 審査（モデレーター） ----------------

  async queue() {
    const rows = (await this.db.query<ReviewRow & { therapist_name: string; shop_name: string }>(
      `${REVIEW_SELECT.replace('FROM reviews r', ', th.name AS therapist_name, s.name AS shop_name FROM reviews r')}
       JOIN therapists th ON th.id=r.therapist_id JOIN shops s ON s.id=th.shop_id
       WHERE r.status='pending' ORDER BY r.created_at ASC`, ['00000000-0000-0000-0000-000000000000'],
    )).rows;
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id, therapistName: r.therapist_name, shopName: r.shop_name,
      authorNickname: r.author_nickname, authorPostCount: Number(r.author_posts),
      body: r.body, flags: r.auto_flags, similarity: r.similarity_score === null ? null : Number(r.similarity_score),
      giftReceived: r.gift_received, listingKind: r.listing_kind, priceYen: r.price_yen, usageVerified: r.usage_verified,
      bodyChars: charLength(r.body),
      answers: { visitedWhen: r.visited_when, courseMinutes: r.course_minutes, ngPrecheck: r.ng_precheck, totalMatched: r.total_matched },
      waitingHours: Math.floor((now - new Date(r.created_at).getTime()) / 3_600_000),
      paidIneligible: r.listing_kind === 'paid'
        ? paidIneligibleReasons({ usageVerified: r.usage_verified, giftReceived: r.gift_received, bodyChars: charLength(r.body), similarity: Number(r.similarity_score ?? 0), flags: r.auto_flags })
        : [],
    }));
  }

  async moderate(moderator: SessionUser, reviewId: string, d: {
    decision: 'approve' | 'approve_free' | 'request_changes' | 'reject'; reason?: string; usageVerified?: boolean;
  }): Promise<{ status: string; listingKind: 'free' | 'paid' }> {
    if ((d.decision === 'request_changes' || d.decision === 'reject') && !d.reason?.trim()) {
      throw new ReviewError(400, 'reason_required', '差し戻し・非公開には理由が必要です');
    }
    return this.db.tx(async (q: Queryable) => {
      const r = (await q.query<{ status: string; listing_kind: 'free' | 'paid'; body: string; gift_received: boolean; usage_verified: boolean; similarity_score: string | null; auto_flags: string[] }>(
        'SELECT status,listing_kind,body,gift_received,usage_verified,similarity_score,auto_flags FROM reviews WHERE id=$1 FOR UPDATE', [reviewId],
      )).rows[0];
      if (!r) throw new ReviewError(404, 'not_found', '口コミが見つかりません');
      if (r.status !== 'pending') throw new ReviewError(409, 'already_decided', 'この口コミはすでに審査済みです');

      const verified = d.usageVerified ?? r.usage_verified;
      let status: string, kind = r.listing_kind;
      if (d.decision === 'approve') {
        if (r.listing_kind === 'paid') {
          const reasons = paidIneligibleReasons({ usageVerified: verified, giftReceived: r.gift_received, bodyChars: charLength(r.body), similarity: Number(r.similarity_score ?? 0), flags: r.auto_flags });
          if (reasons.length) throw new ReviewError(409, 'paid_not_eligible', '有料の条件を満たしていません。無料で公開するか、差し戻してください', reasons);
        }
        status = 'published';
      } else if (d.decision === 'approve_free') {
        status = 'published'; kind = 'free';
      } else if (d.decision === 'request_changes') {
        status = 'changes_requested';
      } else {
        status = 'rejected';
      }
      await q.query(
        `UPDATE reviews SET status=$2, listing_kind=$3, price_yen=CASE WHEN $3='paid' THEN price_yen ELSE NULL END,
           usage_verified=$4, moderated_by=$5, moderated_at=now(), moderation_reason=$6,
           published_at = CASE WHEN $2='published' THEN now() ELSE NULL END WHERE id=$1`,
        [reviewId, status, kind, verified, moderator.id, d.reason?.trim() ?? null],
      );
      await q.query(`INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1,$2,$3,$4)`,
        [moderator.id, `review.${d.decision}`, reviewId, JSON.stringify({ reason: d.reason ?? null, usageVerified: verified, kind })]);
      return { status, listingKind: kind };
    });
  }
}

export { SIMILARITY_FLAG_THRESHOLD };
