import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, makeApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await makeApp(); });
afterAll(async () => { await ctx.close(); });

const tokenFrom = (text: string) => /token=([\w-]+)/.exec(text)?.[1] ?? '';
const body = { email: 'Nazuna@Example.com', nickname: 'nazuna', password: 'correct-horse-9' };

describe('登録・メール確認・ログイン', () => {
  const c = () => new Client(ctx.app);

  it('登録するとパスワードは平文で保存されず、確認メールが届く', async () => {
    const res = await c().post('/api/auth/register', body);
    expect(res.statusCode).toBe(200);
    const row = (await ctx.db.query<{ password_hash: string; email: string }>('SELECT password_hash,email FROM users')).rows[0]!;
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    expect(row.password_hash).not.toContain('correct-horse');
    expect(row.email).toBe('nazuna@example.com');
    const mail = ctx.mailer.outbox.at(-1)!;
    expect(mail.subject).toBe('Hodoku 登録の確認');
    expect(mail.to).toBe('nazuna@example.com');
  });

  it('メール確認前はログインできない', async () => {
    const res = await c().post('/api/auth/login', { email: body.email, password: body.password });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('unverified');
  });

  it('確認リンクは1回しか使えない', async () => {
    const token = tokenFrom(ctx.mailer.outbox.at(-1)!.text);
    const client = c();
    expect((await client.post('/api/auth/verify', { token })).statusCode).toBe(200);
    expect((await client.post('/api/auth/verify', { token })).statusCode).toBe(400);
  });

  it('確認後はログインでき、Cookieは HttpOnly、/me で本人が返る', async () => {
    const client = c();
    const res = await client.post('/api/auth/login', { email: body.email, password: body.password });
    expect(res.statusCode).toBe(200);
    const sess = res.cookies.find((x) => x.name === 'hodoku_session')!;
    expect(sess.httpOnly).toBe(true);
    expect(sess.sameSite).toBe('Lax');
    const me = (await client.get('/api/auth/me')).json();
    expect(me.user.nickname).toBe('nazuna');
    expect(me.user.password_hash).toBeUndefined();
  });

  it('セッションIDはDBにハッシュでしか保存されない', async () => {
    const client = c();
    await client.post('/api/auth/login', { email: body.email, password: body.password });
    const sid = client.jar.get('hodoku_session')!;
    const rows = (await ctx.db.query<{ id_hash: string }>('SELECT id_hash FROM sessions')).rows;
    expect(rows.some((r) => r.id_hash === sid)).toBe(false);
  });

  it('ログアウトでセッションが無効になる', async () => {
    const client = c();
    await client.post('/api/auth/login', { email: body.email, password: body.password });
    const sid = client.jar.get('hodoku_session')!;
    await client.post('/api/auth/logout', {});
    const stale = new Client(ctx.app);
    stale.jar.set('hodoku_session', sid);
    expect((await stale.get('/api/auth/me')).json().user).toBeNull();
  });

  it('同じメール・ニックネームは大文字小文字を問わず重複登録できない', async () => {
    const r1 = await c().post('/api/auth/register', { ...body, email: 'NAZUNA@example.com', nickname: 'other' });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toBe('email_taken');
    const r2 = await c().post('/api/auth/register', { email: 'b@example.com', nickname: 'Nazuna', password: 'abcdefgh1' });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toBe('nickname_taken');
  });

  it('連絡先らしいニックネームと短いパスワードは拒否される', async () => {
    expect((await c().post('/api/auth/register', { email: 'c@example.com', nickname: 'a@b.com', password: 'abcdefgh1' })).json().error).toBe('unsafe_nickname');
    expect((await c().post('/api/auth/register', { email: 'c@example.com', nickname: 'cc', password: 'short' })).json().error).toBe('weak_password');
  });

  it('5回続けて失敗するとロックされ、正しいパスワードでも入れない', async () => {
    const client = c();
    for (let i = 0; i < 5; i++) await client.post('/api/auth/login', { email: body.email, password: 'wrong-wrong' });
    const res = await client.post('/api/auth/login', { email: body.email, password: body.password });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('locked');
    await ctx.db.query('UPDATE users SET locked_until=NULL, failed_logins=0');
  });

  it('存在しないメールでも同じエラーになり、登録の有無を推測できない', async () => {
    const res = await c().post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever-1' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_credentials');
  });
});

describe('パスワード再設定', () => {
  it('存在しないメールでも同じ応答、メールは送られない', async () => {
    const n = ctx.mailer.outbox.length;
    const res = await new Client(ctx.app).post('/api/auth/request-reset', { email: 'ghost@example.com' });
    expect(res.json()).toEqual({ ok: true });
    expect(ctx.mailer.outbox.length).toBe(n);
  });

  it('再設定すると新しいパスワードで入れ、全セッションが無効になる', async () => {
    const old = new Client(ctx.app);
    await old.post('/api/auth/login', { email: body.email, password: body.password });
    const client = new Client(ctx.app);
    await client.post('/api/auth/request-reset', { email: body.email });
    const token = tokenFrom(ctx.mailer.outbox.at(-1)!.text);
    expect((await client.post('/api/auth/reset-password', { token, password: 'brand-new-pass-1' })).statusCode).toBe(200);
    expect((await old.get('/api/auth/me')).json().user).toBeNull();
    expect((await client.post('/api/auth/login', { email: body.email, password: body.password })).statusCode).toBe(401);
    expect((await client.post('/api/auth/login', { email: body.email, password: 'brand-new-pass-1' })).statusCode).toBe(200);
    expect((await client.post('/api/auth/reset-password', { token, password: 'another-pass-22' })).statusCode).toBe(400);
  });
});

describe('CSRF・Origin', () => {
  it('CSRFトークンなしのPOSTは拒否される', async () => {
    const client = new Client(ctx.app);
    await client.get('/healthz');
    const res = await client.post('/api/auth/logout', {}, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('csrf');
  });

  it('別オリジンからのPOSTは拒否される', async () => {
    const res = await new Client(ctx.app).post('/api/auth/logout', {}, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('origin');
  });
});

describe('年齢確認ゲートと静的配信', () => {
  it('未確認だとページは年齢確認へリダイレクトされる（assetsは除く）', async () => {
    const client = new Client(ctx.app);
    const res = await client.get('/shops');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/age?next=%2Fshops');
    expect((await client.get('/assets/hodoku.css')).statusCode).toBe(200);
    expect((await client.get('/age')).statusCode).toBe(200);
    expect((await client.get('/legal')).statusCode).toBe(200);
  });

  it('確認後はページが開き、署名を偽造したCookieは通らない', async () => {
    const client = new Client(ctx.app);
    await client.post('/api/auth/age-confirm', {});
    expect((await client.get('/shops')).statusCode).toBe(200);
    const forged = new Client(ctx.app);
    forged.jar.set('hodoku_age_ok', 'ok.forgedsignature');
    expect((await forged.get('/shops')).statusCode).toBe(302);
  });

  it('パストラバーサルや隠しファイルは返さない', async () => {
    const client = new Client(ctx.app);
    await client.post('/api/auth/age-confirm', {});
    for (const u of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/assets/../../package.json', '/.env', '/src/app.ts']) {
      const res = await client.get(u);
      expect([302, 400, 404], u).toContain(res.statusCode);
      expect(res.body).not.toContain('"name"');
    }
  });

  it('管理・マイページ等は noindex、セキュリティヘッダが付く', async () => {
    const client = new Client(ctx.app);
    await client.post('/api/auth/age-confirm', {});
    const res = await client.get('/admin');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('CSP: script-src は unsafe-inline を使わず per-request nonce で、本文のインライン<script>に一致する nonce が付く', async () => {
    const client = new Client(ctx.app);
    await client.post('/api/auth/age-confirm', {});
    const res = await client.get('/account'); // インライン <script> を持つページ
    const csp = res.headers['content-security-policy'] as string;
    // script-src ディレクティブを取り出す
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((d) => d.startsWith('script-src ')) ?? '';
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    const headerNonce = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(scriptSrc)?.[1];
    expect(headerNonce).toBeTruthy();
    // 本文のインライン <script> に同じ nonce が注入されている（＝CSPで実行が許可される）
    expect(res.body).toContain(`<script nonce="${headerNonce}">`);
    // 追加で締めたディレクティブ
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-src 'none'");
  });
});

describe('レート制限', () => {
  it('ログインを短時間に繰り返すと 429 になる', async () => {
    const limited = await makeApp({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const client = new Client(limited.app);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await client.post('/api/auth/login', { email: 'x@example.com', password: 'whatever-1' })).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally { await limited.close(); }
  });
});
