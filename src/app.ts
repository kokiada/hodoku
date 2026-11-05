import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Mailer } from './lib/mailer.js';
import { AuthService } from './auth/service.js';
import { CatalogService } from './catalog/service.js';
import { ReviewService, ReviewError } from './reviews/service.js';
import { CommerceService, CommerceError } from './commerce/service.js';
import { PointsService, PointsError } from './points/service.js';
import type { PaymentProvider, PointsPaymentProvider } from './payments/provider.js';
import { registerCommerceRoutes } from './routes/commerce.js';
import { registerPointsRoutes } from './routes/points.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerStatic } from './static.js';
import { verifyCsrf, ensureCsrfCookie } from './lib/csrf.js';

export interface AppDeps {
  config: Config;
  db: Db;
  mailer: Mailer;
  publicDir: string;
  payments: PaymentProvider;
  pointsProvider: PointsPaymentProvider;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, mailer, payments, pointsProvider } = deps;
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY === 'true',
    bodyLimit: 64 * 1024,
  });

  // per-request のスクリプト nonce を用意し、CSP ヘッダを自前で付与する。
  // helmet の CSP は使わない（helmet は script/style 両方に nonce を足す実装で、style に nonce が付くと
  // ブラウザが 'unsafe-inline' を無視して全インラインstyleが無効化＝レイアウト崩壊するため）。
  // style は 'unsafe-inline' を維持、script だけ nonce 化して 'unsafe-inline' を外す。
  app.decorateRequest('scriptNonce', '');
  app.addHook('onRequest', async (req, reply) => {
    const nonce = randomBytes(16).toString('base64');
    (req as unknown as { scriptNonce: string }).scriptNonce = nonce;
    const csp = [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      `script-src 'self' 'nonce-${nonce}'`,
      "script-src-attr 'none'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      ...(config.isProd ? ['upgrade-insecure-requests'] : []),
    ].join('; ');
    reply.header('Content-Security-Policy', csp);
  });

  await app.register(helmet, {
    // CSP は上のフックで自前付与するので helmet 側は無効化。他のセキュリティヘッダは helmet に任せる。
    contentSecurityPolicy: false,
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  const auth = new AuthService(db, mailer, config.BASE_URL, config.sessionSecret);
  const catalog = new CatalogService(db);
  const reviews = new ReviewService(db);
  const commerce = new CommerceService(db, payments, {
    feePercent: config.PLATFORM_FEE_PERCENT, minPayoutYen: config.MIN_PAYOUT_YEN, refundWindowHours: config.REFUND_WINDOW_HOURS, payoutsEnabled: config.payoutsEnabled,
  });
  const points = new PointsService(db, pointsProvider, { enabled: config.pointsProvider !== 'disabled', baseUrl: config.BASE_URL });
  app.decorate('deps', { config, db, mailer, auth, catalog, reviews, commerce, points });

  app.addHook('onRequest', async (req, reply) => {
    ensureCsrfCookie(req, reply, config.isProd);
  });

  // 状態を変えるAPIは、CSRFトークン（Cookieとヘッダーの一致）に加えて Origin も検証する
  app.addHook('preHandler', async (req, reply) => {
    if (!UNSAFE.has(req.method) || !req.url.startsWith('/api/')) return;
    // 決済代行会社からのサーバー間Webフックは CSRF/Origin の対象外（署名でプロバイダ側が検証する）
    if (req.url.startsWith('/api/points/webhook/')) return;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.BASE_URL).origin) {
      return reply.code(403).send({ error: 'origin', message: '許可されていないアクセス元です' });
    }
    if (!verifyCsrf(req)) {
      return reply.code(403).send({ error: 'csrf', message: '画面を再読み込みしてからもう一度お試しください' });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof CommerceError) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof PointsError) {
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ReviewError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_input', message: '入力内容を確認してください' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'request_error', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'サーバーでエラーが発生しました' });
  });

  await app.register(registerAuthRoutes, { prefix: '/api/auth' });
  await app.register(registerCatalogRoutes, { prefix: '/api' });
  await app.register(registerReviewRoutes, { prefix: '/api' });
  await app.register(registerCommerceRoutes, { prefix: '/api' });
  await app.register(registerPointsRoutes, { prefix: '/api' });
  await app.register(registerAdminRoutes, { prefix: '/api/admin' });
  app.get('/healthz', async () => ({ ok: true }));
  // 公開フィーチャーフラグ（画面の出し分け用）。
  //  salesEnabled: 有料口コミの閲覧（ポイント消費）を見せるか＝ポイント決済が接続済みか
  //  pointsEnabled: ポイントのチャージができるか
  app.get('/api/config', async () => ({
    salesEnabled: config.pointsProvider !== 'disabled',
    pointsEnabled: config.pointsProvider !== 'disabled',
  }));
  await registerStatic(app, deps.publicDir);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: { config: Config; db: Db; mailer: Mailer; auth: AuthService; catalog: CatalogService; reviews: ReviewService; commerce: CommerceService; points: PointsService };
  }
}
