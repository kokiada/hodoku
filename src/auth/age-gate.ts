import type { FastifyReply, FastifyRequest } from 'fastify';
import { sign, safeEqual } from '../lib/crypto.js';

const COOKIE = 'hodoku_age_ok';
const VALUE = 'ok';
const MAX_AGE_SEC = 60 * 60 * 24 * 30;

/** サーバーがHTMLを返す前に、署名付きCookieで年齢確認済みかを判定する */
export function hasAgeConfirmed(req: FastifyRequest, secret: string): boolean {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return false;
  const [value, sig] = raw.split('.');
  if (!value || !sig) return false;
  return value === VALUE && safeEqual(sig, sign(secret, value));
}

export function setAgeConfirmed(reply: FastifyReply, secret: string, secure: boolean): void {
  const sig = sign(secret, VALUE);
  reply.setCookie(COOKIE, `${VALUE}.${sig}`, {
    path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: MAX_AGE_SEC,
  });
}
