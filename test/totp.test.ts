import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, makeApp, createVerifiedUser, type TestCtx } from './helpers.js';
import { base32Decode, base32Encode, generateTotp, generateTotpSecret, verifyTotp } from '../src/lib/totp.js';

describe('TOTP ライブラリ（RFC 6238）', () => {
  it('base32 は往復変換できる', () => {
    const bufs = [Buffer.from('hello'), Buffer.from([0]), Buffer.from([255, 0, 128, 64, 32])];
    for (const b of bufs) expect(base32Decode(base32Encode(b))).toEqual(b);
  });

  it('RFC 6238 のテストベクタ（SHA-1, seed "12345678901234567890"）に一致する', () => {
    // RFC 6238 Appendix B: SHA-1 シードを base32 にして既知時刻のコードを検証
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    // T=59s → 94287082（下6桁 287082）、T=1111111109 → 07081804（下6桁 081804）
    expect(generateTotp(secret, 59 * 1000)).toBe('287082');
    expect(generateTotp(secret, 1111111109 * 1000)).toBe('081804');
  });

  it('正しいコードは通り、ずれたコードは弾く。±1ステップの時計ずれは許容する', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, generateTotp(secret, now), now)).toBe(true);
    // 1ステップ前のコードも許容（window=1）
    expect(verifyTotp(secret, generateTotp(secret, now - 30_000), now)).toBe(true);
    // 2ステップ前は弾く
    expect(verifyTotp(secret, generateTotp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
    expect(verifyTotp(secret, 'abc', now)).toBe(false);
  });
});

describe('管理者2段階認証（TOTP）ログインフロー', () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(async () => { await ctx.close(); });

  const PW = 'correct-horse-9';

  async function readPending(userId: string): Promise<string> {
    const r = await ctx.db.query<{ totp_secret_pending: string }>('SELECT totp_secret_pending FROM users WHERE id=$1', [userId]);
    return r.rows[0]!.totp_secret_pending;
  }
  async function readActive(userId: string): Promise<string> {
    const r = await ctx.db.query<{ totp_secret: string }>('SELECT totp_secret FROM users WHERE id=$1', [userId]);
    return r.rows[0]!.totp_secret;
  }
  // ある時刻ステップ前のコードで、同一ステップのリプレイを避けつつ検証に使う
  const codeAt = (secret: string, stepOffset = 0) => generateTotp(secret, Date.now() + stepOffset * 30_000);

  it('一般ユーザーは TOTP を設定できない（スタッフ限定）', async () => {
    await createVerifiedUser(ctx.db, { email: 'plainuser@example.com', nickname: 'plainuser', password: PW });
    const c = new Client(ctx.app);
    await c.loginAs('plainuser@example.com', PW);
    expect((await c.post('/api/auth/totp/setup', {})).statusCode).toBe(403);
  });

  it('スタッフは設定→確定でき、以後ログインにコードが必要になる', async () => {
    const adminId = await createVerifiedUser(ctx.db, { email: 'admin-totp@example.com', nickname: 'admintotp', password: PW, role: 'admin' });
    const c = new Client(ctx.app);
    await c.loginAs('admin-totp@example.com', PW);

    // 設定開始（secret と otpauth URI）。この時点では pending に入り、現役は未設定
    const setup = (await c.post('/api/auth/totp/setup', {})).json();
    expect(setup.secret).toBeTruthy();
    expect(setup.uri).toContain('otpauth://totp/');
    expect(await readActive(adminId)).toBeNull();

    // 間違ったコードでは確定できない
    expect((await c.post('/api/auth/totp/confirm', { code: '000000' })).statusCode).toBe(400);

    // 正しいコードで確定（pending が現役へ昇格）
    const secret = await readPending(adminId);
    expect((await c.post('/api/auth/totp/confirm', { code: generateTotp(secret) })).json()).toEqual({ ok: true });
    expect((await c.get('/api/auth/totp/status')).json()).toEqual({ enabled: true });
    expect(await readActive(adminId)).toBe(secret);

    // 次のログイン: パスワードだけではセッションが張られず、チャレンジが返る
    const fresh = new Client(ctx.app);
    const login = await fresh.post('/api/auth/login', { email: 'admin-totp@example.com', password: PW });
    expect(login.statusCode).toBe(200);
    expect(login.json().totpRequired).toBe(true);
    expect(login.json().user).toBeUndefined();
    const challenge = login.json().challenge as string;

    // 間違ったコードは 401
    expect((await fresh.post('/api/auth/login/totp', { challenge, code: '000000' })).statusCode).toBe(401);

    // 正しいコードでログイン完了→ /me で本人が返る（confirmで消費した現ステップとは別の+1ステップのコードを使う）
    const ok = await fresh.post('/api/auth/login/totp', { challenge, code: codeAt(secret, 1) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe('admin-totp@example.com');
    expect((await fresh.get('/api/auth/me')).json().user.email).toBe('admin-totp@example.com');
  });

  it('有効中に再setupしても、コード無しでは2段階認証は無効化されない（ダウングレード防止）', async () => {
    const adminId = await createVerifiedUser(ctx.db, { email: 'nodown@example.com', nickname: 'nodown', password: PW, role: 'admin' });
    const c = new Client(ctx.app);
    await c.loginAs('nodown@example.com', PW);
    await c.post('/api/auth/totp/setup', {});
    const secret = await readPending(adminId);
    await c.post('/api/auth/totp/confirm', { code: generateTotp(secret) });
    expect((await c.get('/api/auth/totp/status')).json()).toEqual({ enabled: true });

    // 再度 setup を呼んでも、現役シークレットと有効状態は維持される
    await c.post('/api/auth/totp/setup', {});
    expect((await c.get('/api/auth/totp/status')).json()).toEqual({ enabled: true });
    expect(await readActive(adminId)).toBe(secret);
    // 新しいログインでも依然コードが要求される
    const fresh = new Client(ctx.app);
    const login = await fresh.post('/api/auth/login', { email: 'nodown@example.com', password: PW });
    expect(login.json().totpRequired).toBe(true);
  });

  it('同じコードは2回使えない（リプレイ拒否）', async () => {
    const adminId = await createVerifiedUser(ctx.db, { email: 'replay@example.com', nickname: 'replay', password: PW, role: 'admin' });
    const c = new Client(ctx.app);
    await c.loginAs('replay@example.com', PW);
    await c.post('/api/auth/totp/setup', {});
    const secret = await readPending(adminId);
    // 1ステップ先のコードで確定（以後 last_counter が進む）
    const code = codeAt(secret, 1);
    await c.post('/api/auth/totp/confirm', { code });

    // 同じコードでログインを試みると拒否される（確定で消費済みのカウンタ）
    const fresh = new Client(ctx.app);
    const challenge = (await fresh.post('/api/auth/login', { email: 'replay@example.com', password: PW })).json().challenge as string;
    expect((await fresh.post('/api/auth/login/totp', { challenge, code })).statusCode).toBe(401);
  });

  it('改ざんしたチャレンジは拒否される', async () => {
    const adminId = await createVerifiedUser(ctx.db, { email: 'admin2@example.com', nickname: 'admin2', password: PW, role: 'admin' });
    const c = new Client(ctx.app);
    await c.loginAs('admin2@example.com', PW);
    await c.post('/api/auth/totp/setup', {});
    const secret = await readPending(adminId);
    await c.post('/api/auth/totp/confirm', { code: generateTotp(secret) });

    const fresh = new Client(ctx.app);
    const challenge = (await fresh.post('/api/auth/login', { email: 'admin2@example.com', password: PW })).json().challenge as string;
    const tampered = challenge.replace(/\.[^.]+$/u, '.deadbeef');
    expect((await fresh.post('/api/auth/login/totp', { challenge: tampered, code: codeAt(secret) })).statusCode).toBe(401);
  });

  it('TOTP を無効化すると、再びパスワードのみでログインできる', async () => {
    const adminId = await createVerifiedUser(ctx.db, { email: 'admin3@example.com', nickname: 'admin3', password: PW, role: 'admin' });
    const c = new Client(ctx.app);
    await c.loginAs('admin3@example.com', PW);
    await c.post('/api/auth/totp/setup', {});
    const secret = await readPending(adminId);
    await c.post('/api/auth/totp/confirm', { code: generateTotp(secret) });

    // 無効化（コード必須）。確定と別ステップのコードを使う
    expect((await c.post('/api/auth/totp/disable', { code: codeAt(secret, 1) })).json()).toEqual({ ok: true });

    // パスワードのみでセッションが張られる（totpRequired は返らない）
    const fresh = new Client(ctx.app);
    const login = await fresh.post('/api/auth/login', { email: 'admin3@example.com', password: PW });
    expect(login.json().totpRequired).toBeUndefined();
    expect(login.json().user.email).toBe('admin3@example.com');
  });
});
