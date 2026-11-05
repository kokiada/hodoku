import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionUser } from './service.js';
import { getSessionId } from './session-cookie.js';

/** ログインしていれば本人を返す。未ログインは null（公開ページ用） */
export async function optionalUser(req: FastifyRequest): Promise<SessionUser | null> {
  const sid = getSessionId(req);
  return sid ? req.server.deps.auth.currentUser(sid) : null;
}

/** ログイン必須。未ログインなら 401 を返して null */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
  const u = await optionalUser(req);
  if (!u) { reply.code(401).send({ error: 'login_required', message: 'ログインが必要です' }); return null; }
  return u;
}

/** 運営権限必須。権限が無ければ存在を隠さず 403 */
export async function requireStaff(req: FastifyRequest, reply: FastifyReply, roles: Array<'moderator' | 'admin'> = ['moderator', 'admin']): Promise<SessionUser | null> {
  const u = await requireUser(req, reply);
  if (!u) return null;
  if (!roles.includes(u.role as 'moderator' | 'admin')) { reply.code(403).send({ error: 'forbidden', message: '権限がありません' }); return null; }
  return u;
}
