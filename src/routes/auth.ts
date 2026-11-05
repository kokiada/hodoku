import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthError } from '../auth/service.js';
import { getSessionId, setSessionCookie, clearSessionCookie } from '../auth/session-cookie.js';
import { setAgeConfirmed } from '../auth/age-gate.js';
import { requireStaff } from '../auth/guard.js';

const registerBody = z.object({ email: z.string(), nickname: z.string(), password: z.string() });
const loginBody = z.object({ email: z.string(), password: z.string() });
const totpLoginBody = z.object({ challenge: z.string(), code: z.string() });
const totpCodeBody = z.object({ code: z.string() });
const tokenBody = z.object({ token: z.string() });
const resetBody = z.object({ token: z.string(), password: z.string() });

export async function registerAuthRoutes(app: FastifyInstance) {
  const { auth, config } = app.deps;
  const limited = { config: { rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: '15 minutes' } } };

  app.post('/age-confirm', async (req, reply) => {
    setAgeConfirmed(reply, config.sessionSecret, config.isProd);
    return { ok: true };
  });

  app.post('/register', limited, async (req, reply) => {
    const body = registerBody.parse(req.body);
    try {
      await auth.register(body.email, body.nickname, body.password);
      return { ok: true };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  app.post('/verify', limited, async (req, reply) => {
    const { token } = tokenBody.parse(req.body);
    try {
      await auth.verifyEmail(token);
      return { ok: true };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  app.post('/login', limited, async (req, reply) => {
    const body = loginBody.parse(req.body);
    try {
      const result = await auth.login(body.email, body.password, req.headers['user-agent']);
      if (!result.ok) {
        // パスワードは通過。2段階認証のコード入力が必要
        return { totpRequired: true, challenge: result.challenge };
      }
      setSessionCookie(reply, result.sessionId, config.isProd);
      return { user: result.user };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(401).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  app.post('/login/totp', limited, async (req, reply) => {
    const body = totpLoginBody.parse(req.body);
    try {
      const { sessionId, user } = await auth.completeLoginWithTotp(body.challenge, body.code, req.headers['user-agent']);
      setSessionCookie(reply, sessionId, config.isProd);
      return { user };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(401).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  app.post('/logout', async (req, reply) => {
    const sid = getSessionId(req);
    if (sid) await auth.logout(sid);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const sid = getSessionId(req);
    const user = sid ? await auth.currentUser(sid) : null;
    return { user };
  });

  app.post('/request-reset', limited, async (req) => {
    const { email } = z.object({ email: z.string() }).parse(req.body);
    await auth.requestPasswordReset(email);
    return { ok: true }; // 存在有無を問わず同じ応答
  });

  app.post('/reset-password', limited, async (req, reply) => {
    const body = resetBody.parse(req.body);
    try {
      await auth.resetPassword(body.token, body.password);
      return { ok: true };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  // --- 2段階認証（TOTP）: 運営スタッフ（moderator/admin）向け ---
  app.get('/totp/status', async (req, reply) => {
    const u = await requireStaff(req, reply);
    if (!u) return reply;
    return auth.totpStatus(u.id);
  });

  app.post('/totp/setup', limited, async (req, reply) => {
    const u = await requireStaff(req, reply);
    if (!u) return reply;
    // 認証アプリ登録用のシークレットと otpauth URI を返す（確定は /totp/confirm）
    return auth.beginTotpEnrollment(u.id, u.email);
  });

  app.post('/totp/confirm', limited, async (req, reply) => {
    const u = await requireStaff(req, reply);
    if (!u) return reply;
    const { code } = totpCodeBody.parse(req.body);
    try {
      await auth.confirmTotpEnrollment(u.id, code);
      return { ok: true };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.code, message: e.message });
      throw e;
    }
  });

  app.post('/totp/disable', limited, async (req, reply) => {
    const u = await requireStaff(req, reply);
    if (!u) return reply;
    const { code } = totpCodeBody.parse(req.body);
    try {
      await auth.disableTotp(u.id, code);
      return { ok: true };
    } catch (e) {
      if (e instanceof AuthError) return reply.code(400).send({ error: e.code, message: e.message });
      throw e;
    }
  });
}
