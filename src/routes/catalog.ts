import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { optionalUser } from '../auth/guard.js';
import { rateKey } from '../lib/rate-key.js';

const minutes = z.coerce.number().refine((n): n is 60 | 90 | 120 => [60, 90, 120].includes(n)).default(90);
const listQuery = z.object({
  station: z.string().optional(),                  // 例: 恵比寿,渋谷
  flags: z.string().optional(),                    // 例: ng,desk,cancel,first
  budget: z.coerce.number().int().positive().optional(),
  minutes,
  sort: z.enum(['total', 'reviews', 'updated']).default('total'),
});

export async function registerCatalogRoutes(app: FastifyInstance) {
  const { catalog, reviews } = app.deps;

  app.get('/shops', async (req) => {
    const q = listQuery.parse(req.query);
    const shops = await catalog.listShops({
      stations: q.station?.split(',').filter(Boolean), flags: q.flags?.split(',').filter(Boolean),
      budgetYen: q.budget, minutes: q.minutes as 60 | 90 | 120, sort: q.sort,
    });
    return { shops };
  });

  app.get('/shops/:slug', async (req, reply) => {
    const { slug } = z.object({ slug: z.string().max(80) }).parse(req.params);
    const { minutes: m } = z.object({ minutes }).parse(req.query);
    const shop = await catalog.getShop(slug, m as 60 | 90 | 120);
    if (!shop) return reply.code(404).send({ error: 'not_found', message: '店舗が見つかりません' });
    return { shop };
  });

  // 人（担当者）から探す一覧
  app.get('/therapists', async (req) => {
    const q = z.object({
      station: z.string().optional(),
      q: z.string().max(80).optional(),
      sort: z.enum(['reviews', 'recent', 'trust']).default('reviews'),
    }).parse(req.query);
    const therapists = await catalog.listTherapists({
      stations: q.station?.split(',').filter(Boolean), keyword: q.q, sort: q.sort,
    });
    return { therapists };
  });

  app.get('/therapists/:slug', async (req, reply) => {
    const { slug } = z.object({ slug: z.string().max(80) }).parse(req.params);
    const data = await reviews.listForTherapist(slug, await optionalUser(req));
    if (!data) return reply.code(404).send({ error: 'not_found', message: '担当者が見つかりません' });
    return data;
  });

  // 削除・訂正の依頼（情報流通プラットフォーム対処法の受付）。追記専用の監査ログに記録する。
  app.post('/removal-request', { config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req) => {
    const body = z.object({
      url: z.string().url().max(2000),
      kind: z.enum(['factual', 'rights', 'other']),
      email: z.string().email().max(200),
      detail: z.string().min(1).max(2000),
    }).parse(req.body);
    const user = await optionalUser(req);
    await app.deps.db.query(
      `INSERT INTO audit_log (actor_id, action, target, detail) VALUES ($1,'removal_request',$2,$3)`,
      [user?.id ?? null, body.url, JSON.stringify({ kind: body.kind, email: body.email, detail: body.detail })],
    );
    return { ok: true };
  });
}
