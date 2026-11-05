import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStaff } from '../auth/guard.js';

export async function registerAdminRoutes(app: FastifyInstance) {
  const { reviews, commerce } = app.deps;
  const uuid = z.object({ id: z.string().uuid() });

  // 管理画面のAPIは検索エンジン・キャッシュに残さない
  app.addHook('onSend', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Robots-Tag', 'noindex'); });

  app.get('/queue', async (req, reply) => {
    if (!(await requireStaff(req, reply))) return;
    return { items: await reviews.queue() };
  });

  app.post('/reviews/:id/moderate', async (req, reply) => {
    const staff = await requireStaff(req, reply); if (!staff) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      decision: z.enum(['approve', 'approve_free', 'request_changes', 'reject']),
      reason: z.string().max(500).optional(),
      usageVerified: z.boolean().optional(),
    }).parse(req.body);
    return reviews.moderate(staff, id, body);
  });

  // 返金の判断は運営(モデレーター以上)
  app.get('/refunds', async (req, reply) => {
    if (!(await requireStaff(req, reply))) return;
    return { items: await commerce.refundQueue() };
  });
  app.post('/refunds/:id/decide', async (req, reply) => {
    const staff = await requireStaff(req, reply); if (!staff) return;
    const { id } = uuid.parse(req.params);
    const { decision } = z.object({ decision: z.enum(['approve', 'deny']) }).parse(req.body);
    return commerce.decideRefund(staff, id, decision);
  });

  // お金が動く出金の判断は管理者のみ（モデレーターは不可）
  app.get('/payouts', async (req, reply) => {
    if (!(await requireStaff(req, reply, ['admin']))) return;
    return { items: await commerce.payoutQueue() };
  });
  // 振込実行のため口座番号を含む全情報を開示する（admin のみ・閲覧を監査ログに記録）
  app.get('/payouts/:id/bank', async (req, reply) => {
    const admin = await requireStaff(req, reply, ['admin']); if (!admin) return;
    const { id } = uuid.parse(req.params);
    const bank = await commerce.revealBankAccountForPayout(id);
    if (!bank) return reply.code(404).send({ error: 'not_found', message: '振込先が見つかりません' });
    await app.deps.db.query(`INSERT INTO audit_log (actor_id,action,target) VALUES ($1,'payout.bank_reveal',$2)`, [admin.id, id]);
    return { bank };
  });
  app.post('/payouts/:id/decide', async (req, reply) => {
    const admin = await requireStaff(req, reply, ['admin']); if (!admin) return;
    const { id } = uuid.parse(req.params);
    const { decision, paidNote } = z.object({ decision: z.enum(['paid', 'denied']), paidNote: z.string().max(300).optional() }).parse(req.body);
    return commerce.decidePayout(admin, id, decision, paidNote);
  });

  app.get('/reports', async (req, reply) => {
    if (!(await requireStaff(req, reply))) return;
    return { items: await commerce.reportQueue() };
  });
  app.post('/reports/:id/close', async (req, reply) => {
    const staff = await requireStaff(req, reply); if (!staff) return;
    const { id } = uuid.parse(req.params);
    const { unpublish } = z.object({ unpublish: z.boolean() }).parse(req.body);
    await commerce.closeReport(staff, id, unpublish);
    return { ok: true };
  });
}
