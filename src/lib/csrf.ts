import type { FastifyReply, FastifyRequest } from 'fastify';
import { newToken, safeEqual } from './crypto.js';

const COOKIE = 'hodoku_csrf';
const HEADER = 'x-csrf-token';

/** Double-submit cookie方式。CookieはhttpOnlyにせずJSから読めるようにし、
 *  状態を変える全リクエストでヘッダー値と照合する */
export function ensureCsrfCookie(req: FastifyRequest, reply: FastifyReply, secure: boolean): void {
  if (req.cookies?.[COOKIE]) return;
  reply.setCookie(COOKIE, newToken(16), { path: '/', httpOnly: false, sameSite: 'lax', secure });
}

export function verifyCsrf(req: FastifyRequest): boolean {
  const cookie = req.cookies?.[COOKIE];
  const header = req.headers[HEADER];
  if (!cookie || typeof header !== 'string') return false;
  return safeEqual(cookie, header);
}
