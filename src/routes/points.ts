import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guard.js';
import { rateKey } from '../lib/rate-key.js';
import { PaymentError } from '../payments/provider.js';

export async function registerPointsRoutes(app: FastifyInstance) {
  const { points } = app.deps;

  // チャージパック一覧（画面表示用）
  app.get('/points/packs', async () => ({ packs: points.packs() }));

  // 残高・履歴
  app.get('/me/points', async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    return points.summary(user);
  });

  // チャージ開始：支払額（円）はパック定義にあるものだけ。結果のURLへリダイレクトする
  app.post('/points/charge', { config: { rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    const { packYen } = z.object({ packYen: z.coerce.number().int() }).parse(req.body);
    return reply.code(201).send(await points.beginCharge(user, packYen));
  });

  // 有料口コミをポイントで解放する（消費）
  app.post('/reviews/:id/unlock', { config: { rateLimit: { max: 60, timeWindow: '1 hour', keyGenerator: rateKey } } }, async (req, reply) => {
    const user = await requireUser(req, reply); if (!user) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return points.unlockReview(user, id);
  });

  // 決済完了のWebフック（決済代行会社からのサーバー間通知）。
  // 署名検証のため生のボディが必要。この経路だけ別プラグインに分離し、JSONを文字列のまま受け取る。
  await app.register(async (hook) => {
    hook.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    hook.post('/points/webhook/bitcash', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      try {
        await points.handleWebhook(raw, headers);
        return { ok: true };
      } catch (e) {
        if (e instanceof PaymentError) return reply.code(400).send({ error: e.code, message: e.message });
        throw e;
      }
    });
  });
}
