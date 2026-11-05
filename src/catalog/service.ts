import type { Queryable } from '../db/index.js';
import { totalFee, courseFee } from '../domain/rules.js';
import { trustLevel, type TrustLevel } from '../domain/trust.js';

export interface ShopSummary {
  slug: string; name: string; area: string; station: string; lastCheckedAt: string | null; isSample: boolean;
  totalYen: number; minutes: number;
  hasNgPrecheck: boolean; hasSupportDesk: boolean; freeChangeHours: number | null; firstTimeFriendly: boolean;
  reviewCount: number; trust: TrustLevel;
}

interface ShopRow {
  id: string; slug: string; name: string; area: string; station: string; last_checked_at: string | null;
  base_price_yen: number; price_step_yen: number; nomination_fee_yen: number; transport_fee_yen: number; extension_fee_yen: number;
  has_ng_precheck: boolean; has_support_desk: boolean; free_change_hours: number | null; first_time_friendly: boolean;
  is_sample: boolean; safety_notes: unknown; cancel_policy: unknown; review_count: string; verified_count: string;
}

const SHOP_SELECT = `
  SELECT s.*, to_char(s.last_checked_at, 'YYYY-MM-DD') AS last_checked_at,
    COALESCE(c.n,0) AS review_count, COALESCE(c.v,0) AS verified_count
  FROM shops s
  LEFT JOIN (
    SELECT t.shop_id, count(*) AS n, count(*) FILTER (WHERE r.usage_verified) AS v
    FROM reviews r JOIN therapists t ON t.id = r.therapist_id
    WHERE r.status = 'published' GROUP BY t.shop_id
  ) c ON c.shop_id = s.id
  WHERE s.published`;

const toSummary = (r: ShopRow, minutes: number): ShopSummary => {
  const pricing = { basePriceYen: r.base_price_yen, priceStepYen: r.price_step_yen, nominationFeeYen: r.nomination_fee_yen, transportFeeYen: r.transport_fee_yen };
  const n = Number(r.review_count), v = Number(r.verified_count);
  return {
    slug: r.slug, name: r.name, area: r.area, station: r.station, isSample: r.is_sample,
    lastCheckedAt: r.last_checked_at ?? null,
    totalYen: totalFee(pricing, minutes), minutes,
    hasNgPrecheck: r.has_ng_precheck, hasSupportDesk: r.has_support_desk, freeChangeHours: r.free_change_hours,
    firstTimeFriendly: r.first_time_friendly, reviewCount: n, trust: trustLevel(n, v),
  };
};

export interface ShopQuery {
  stations?: string[]; flags?: string[]; budgetYen?: number; minutes: 60 | 90 | 120; sort: 'total' | 'reviews' | 'updated';
}

export interface TherapistSummary {
  slug: string; name: string; bio: string; texture: string;
  shopSlug: string; shopName: string; area: string; station: string;
  reviewCount: number; verifiedCount: number; paidCount: number; trust: TrustLevel;
  lastReviewedAt: string | null;
}

export interface TherapistQuery {
  stations?: string[]; keyword?: string; sort: 'reviews' | 'recent' | 'trust';
}

export class CatalogService {
  constructor(private db: Queryable) {}

  async listShops(q: ShopQuery): Promise<ShopSummary[]> {
    const rows = (await this.db.query<ShopRow>(`${SHOP_SELECT} ORDER BY s.name`)).rows;
    let out = rows.map((r) => ({ r, s: toSummary(r, q.minutes) }));
    if (q.stations?.length) out = out.filter((x) => q.stations!.includes(x.s.station));
    const f = new Set(q.flags ?? []);
    if (f.has('ng')) out = out.filter((x) => x.s.hasNgPrecheck);
    if (f.has('desk')) out = out.filter((x) => x.s.hasSupportDesk);
    if (f.has('cancel')) out = out.filter((x) => (x.s.freeChangeHours ?? 0) >= 24);
    if (f.has('first')) out = out.filter((x) => x.s.firstTimeFriendly);
    if (q.budgetYen) out = out.filter((x) => x.s.totalYen <= q.budgetYen!);
    const cmp: Record<ShopQuery['sort'], (a: ShopSummary, b: ShopSummary) => number> = {
      total: (a, b) => a.totalYen - b.totalYen,
      reviews: (a, b) => b.reviewCount - a.reviewCount,
      updated: (a, b) => (b.lastCheckedAt ?? '').localeCompare(a.lastCheckedAt ?? ''),
    };
    return out.map((x) => x.s).sort(cmp[q.sort]);
  }

  /** 人（担当者）から探す一覧。店舗横断で、口コミ数・直近の活動・信頼度を返す */
  async listTherapists(q: TherapistQuery): Promise<TherapistSummary[]> {
    const rows = (await this.db.query<{
      slug: string; name: string; bio: string; texture: string; shop_slug: string; shop_name: string; area: string; station: string;
      n: string; v: string; paid: string; last_reviewed_at: string | null;
    }>(
      `SELECT t.slug, t.name, t.bio, t.texture, s.slug AS shop_slug, s.name AS shop_name, s.area, s.station,
         count(r.id) FILTER (WHERE r.status='published') AS n,
         count(r.id) FILTER (WHERE r.status='published' AND r.usage_verified) AS v,
         count(r.id) FILTER (WHERE r.status='published' AND r.listing_kind='paid') AS paid,
         to_char(max(r.published_at) FILTER (WHERE r.status='published'), 'YYYY-MM-DD') AS last_reviewed_at
       FROM therapists t JOIN shops s ON s.id = t.shop_id
       LEFT JOIN reviews r ON r.therapist_id = t.id
       WHERE t.published AND s.published
       GROUP BY t.id, s.id`,
    )).rows;
    let out: TherapistSummary[] = rows.map((r) => {
      const n = Number(r.n), v = Number(r.v);
      return {
        slug: r.slug, name: r.name, bio: r.bio, texture: r.texture,
        shopSlug: r.shop_slug, shopName: r.shop_name, area: r.area, station: r.station,
        reviewCount: n, verifiedCount: v, paidCount: Number(r.paid), trust: trustLevel(n, v),
        lastReviewedAt: r.last_reviewed_at ?? null,
      };
    });
    if (q.stations?.length) out = out.filter((t) => q.stations!.includes(t.station));
    if (q.keyword) {
      const kw = q.keyword.trim().toLowerCase();
      if (kw) out = out.filter((t) => `${t.name} ${t.bio} ${t.shopName} ${t.area}`.toLowerCase().includes(kw));
    }
    const cmp: Record<TherapistQuery['sort'], (a: TherapistSummary, b: TherapistSummary) => number> = {
      // 「話題」＝口コミ数が多い順。沼っている人の“他の人の口コミ”が気になる訴求に合わせる
      reviews: (a, b) => b.reviewCount - a.reviewCount || (b.lastReviewedAt ?? '').localeCompare(a.lastReviewedAt ?? ''),
      recent: (a, b) => (b.lastReviewedAt ?? '').localeCompare(a.lastReviewedAt ?? ''),
      trust: (a, b) => b.verifiedCount - a.verifiedCount || b.reviewCount - a.reviewCount,
    };
    return out.sort(cmp[q.sort]);
  }

  async getShop(slug: string, minutes: 60 | 90 | 120) {
    const row = (await this.db.query<ShopRow>(`${SHOP_SELECT} AND s.slug = $1`, [slug])).rows[0];
    if (!row) return null;
    const pricing = { basePriceYen: row.base_price_yen, priceStepYen: row.price_step_yen, nominationFeeYen: row.nomination_fee_yen, transportFeeYen: row.transport_fee_yen };
    const therapists = (await this.db.query<{ slug: string; name: string; bio: string; texture: string; n: string; v: string }>(
      `SELECT t.slug, t.name, t.bio, t.texture,
         count(r.id) FILTER (WHERE r.status='published') AS n,
         count(r.id) FILTER (WHERE r.status='published' AND r.usage_verified) AS v
       FROM therapists t LEFT JOIN reviews r ON r.therapist_id = t.id
       WHERE t.shop_id = $1 AND t.published GROUP BY t.id ORDER BY t.name`, [row.id],
    )).rows;
    return {
      ...toSummary(row, minutes),
      breakdown: {
        course: courseFee(pricing, minutes), nomination: row.nomination_fee_yen, transport: row.transport_fee_yen,
        extension30: row.extension_fee_yen,
      },
      safetyNotes: row.safety_notes, cancelPolicy: row.cancel_policy,
      therapists: therapists.map((t) => ({
        slug: t.slug, name: t.name, bio: t.bio, texture: t.texture,
        reviewCount: Number(t.n), trust: trustLevel(Number(t.n), Number(t.v)),
      })),
    };
  }
}
