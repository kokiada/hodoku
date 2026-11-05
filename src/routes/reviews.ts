import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import { rateKey } from '../lib/rate-key.js';
import type { NewReview } from '../reviews/service.js';

const score = z.number().int().min(1).max(5);
const submitBody = z.object({
  therapistSlug: z.string().max(80),
  visitedWhen: z.enum(['this_month', 'last_month', 'few_months_ago']),
  courseMinutes: z.union([z.literal(60), z.literal(90), z.literal(120)]),
  ngPrecheck: z.enum(['on_booking', 'on_site', 'none']),
  totalMatched: z.enum(['matched', 'slightly_off', 'very_off']),
  scoreCare: score, scoreComfort: score, scorePunctual: score,
  giftReceived: z.boolean(),
  body: z.string().max(4000).default(''),
  listing: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('free') }),
    z.object({ kind: z.literal('paid'), priceYen: z.number().int() }),
  ]).default({ kind: 'free' }),
});

export async function registerReviewRoutes(app: FastifyInstance) {
  const { reviews } = app.deps;

  app.post('/reviews', { config: { rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    const input = submitBody.parse(req.body) as NewReview;
    const r = await reviews.submit(user, input);
    return reply.code(201).send(r);
  });

  app.get('/me/reviews', async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    return { reviews: await reviews.mine(user) };
  });

  app.post('/reviews/:id/helpful', async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return reviews.toggleHelpful(user, id);
  });

  app.post('/reviews/:id/report', { config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);
    await reviews.report(user, id, reason);
    return { ok: true };
  });
}
