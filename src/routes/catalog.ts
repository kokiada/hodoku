import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { optionalUser } from '../auth/guard.js';

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
}
