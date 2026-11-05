import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE = 'hodoku_session';

export const getSessionId = (req: FastifyRequest): string | undefined => req.cookies?.[COOKIE];

export function setSessionCookie(reply: FastifyReply, sessionId: string, secure: boolean): void {
  reply.setCookie(COOKIE, sessionId, {
    path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}
