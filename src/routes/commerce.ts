import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import { rateKey } from '../lib/rate-key.js';

export async function registerCommerceRoutes(app: FastifyInstance) {
  const { commerce } = app.deps;
  const id = z.object({ id: z.string().uuid() });

  // 金額はサーバーが口コミから決める。リクエストには価格を含めない
  app.post('/reviews/:id/purchase', { config: { rateLimit: { max: 30, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    const { id: reviewId } = id.parse(req.params);
    return reply.code(201).send(await commerce.purchase(user, reviewId));
  });

  app.get('/me/purchases', async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    return { purchases: await commerce.myPurchases(user) };
  });

  app.post('/purchases/:id/refund-request', { config: { rateLimit: { max: 10, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    const { id: purchaseId } = id.parse(req.params);
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);
    return reply.code(201).send(await commerce.requestRefund(user, purchaseId, reason));
  });

  app.get('/me/summary', async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    return commerce.summary(user);
  });

  app.post('/me/payouts', { config: { rateLimit: { max: 5, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    return reply.code(201).send(await commerce.requestPayout(user));
  });
}
