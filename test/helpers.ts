import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPgliteDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedCatalog } from '../src/db/seed.js';
import { hashPassword } from '../src/lib/crypto.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { StubPaymentProvider, StubPointsProvider } from '../src/payments/provider.js';

export interface TestCtx { app: FastifyInstance; db: Db; mailer: MemoryMailer; payments: StubPaymentProvider; points: StubPointsProvider; close(): Promise<void> }

export async function makeApp(env: Record<string, string> = {}): Promise<TestCtx> {
  const config = loadConfig({ NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '1000', ...env } as NodeJS.ProcessEnv);
  const db = await createPgliteDb();
  await migrate(db);
  await seedCatalog(db);
  const mailer = new MemoryMailer();
  const payments = new StubPaymentProvider();
  const points = new StubPointsProvider();
  const app = await buildApp({ config, db, mailer, publicDir: join(process.cwd(), 'public'), payments, pointsProvider: points });
  await app.ready();
  return { app, db, mailer, payments, points, close: async () => { await app.close(); await db.close(); } };
}

/** テスト用に、確認済みユーザーを直接DBへ作る（メール往復を省く） */
export async function createVerifiedUser(db: Db, opts: { email: string; nickname: string; password: string; role?: 'user' | 'moderator' | 'admin' }): Promise<string> {
  const id = randomUUID();
  const hash = await hashPassword(opts.password);
  await db.query(
    `INSERT INTO users (id,email,nickname,password_hash,role,email_verified_at) VALUES ($1,$2,$3,$4,$5,now())`,
    [id, opts.email.toLowerCase(), opts.nickname, hash, opts.role ?? 'user'],
  );
  return id;
}

/** Cookieを保持する簡易クライアント（ブラウザの代わり） */
export class Client {
  jar = new Map<string, string>();
  constructor(private app: FastifyInstance) {}

  private cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  private absorb(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) this.jar.delete(c.name);
      else this.jar.set(c.name, c.value);
    }
  }

  async get(url: string) {
    const res = await this.app.inject({ method: 'GET', url, headers: { cookie: this.cookieHeader() } });
    this.absorb(res);
    return res;
  }

  async send(method: 'POST' | 'PUT' | 'DELETE', url: string, body: unknown, opts: { csrf?: boolean; origin?: string } = {}) {
    if (!this.jar.has('hodoku_csrf')) await this.get('/healthz');
    const headers: Record<string, string> = { cookie: this.cookieHeader(), 'content-type': 'application/json' };
    if (opts.csrf !== false) headers['x-csrf-token'] = this.jar.get('hodoku_csrf') ?? '';
    if (opts.origin) headers.origin = opts.origin;
    const res = await this.app.inject({ method, url, headers, payload: JSON.stringify(body) });
    this.absorb(res);
    return res;
  }

  post(url: string, body: unknown, opts?: { csrf?: boolean; origin?: string }) { return this.send('POST', url, body, opts); }

  async loginAs(email: string, password: string) {
    const res = await this.post('/api/auth/login', { email, password });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
    return res;
  }
}
