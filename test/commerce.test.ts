import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, createVerifiedUser, makeApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let authorId: string, therapistId: string;
const PW = 'password-123';
const SECRET_TAIL = '購入後にだけ読める後半の本文です';

async function login(email: string) { const c = new Client(ctx.app); await c.loginAs(email, PW); return c; }
async function newUser(tag: string, role: 'user' | 'moderator' | 'admin' = 'user') {
  const email = `${tag}@example.com`;
  const id = await createVerifiedUser(ctx.db, { email, nickname: tag, password: PW, role });
  return { id, email };
}
async function publishPaid(price: number, authorOverride?: string): Promise<string> {
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,
       body,listing_kind,price_yen,usage_verified,status,published_at)
     VALUES ($1,$2,$3,'this_month',90,'on_booking','matched',5,5,5,$4,'paid',$5,true,'published',now())`,
    [id, authorOverride ?? authorId, therapistId, 'あ'.repeat(70) + SECRET_TAIL, price],
  );
  return id;
}
const balance = async (uid: string) => Number((await ctx.db.query<{ s: string | null }>('SELECT sum(amount_yen) AS s FROM ledger_entries WHERE user_id=$1', [uid])).rows[0]!.s ?? 0);

beforeAll(async () => {
  ctx = await makeApp({ MIN_PAYOUT_YEN: '1000' });
  authorId = (await newUser('seller')).id;
  therapistId = (await ctx.db.query<{ id: string }>(`SELECT id FROM therapists WHERE slug='kai'`)).rows[0]!.id;
});
afterAll(async () => { await ctx.close(); });
beforeEach(() => { ctx.payments.failNextCharge = false; ctx.payments.failNextRefund = false; });

describe('購入と分配', () => {
  it('¥300の購入で、購入者は全文が読め、投稿者に¥270・運営手数料¥30が記録される', async () => {
    const buyer = await newUser('buyer1');
    const reviewId = await publishPaid(300);
    const c = await login(buyer.email);

    const res = await c.post(`/api/reviews/${reviewId}/purchase`, {});
    expect(res.statusCode).toBe(201);
    expect(res.json().priceYen).toBe(300);

    const p = (await ctx.db.query<{ price_yen: number; fee_yen: number; author_net_yen: number; status: string }>('SELECT * FROM purchases WHERE review_id=$1', [reviewId])).rows[0]!;
    expect(p).toMatchObject({ price_yen: 300, fee_yen: 30, author_net_yen: 270, status: 'completed' });
    expect(await balance(authorId)).toBe(270);

    const page = (await c.get('/api/therapists/kai')).json();
    expect(page.reviews.find((r: { id: string }) => r.id === reviewId).body).toContain(SECRET_TAIL);
  });

  it('価格はクライアントが指定できない（リクエストに価格を入れても無視される）', async () => {
    const buyer = await newUser('buyer2');
    const reviewId = await publishPaid(500);
    const c = await login(buyer.email);
    const res = await c.post(`/api/reviews/${reviewId}/purchase`, { priceYen: 1, price: 1 });
    expect(res.json().priceYen).toBe(500);
    expect((await ctx.db.query<{ price_yen: number }>('SELECT price_yen FROM purchases WHERE buyer_id=(SELECT id FROM users WHERE nickname=$1)', ['buyer2'])).rows[0]!.price_yen).toBe(500);
  });

  it('同じ口コミは2回買えず、2回目は課金も売上計上もされない', async () => {
    const buyer = await newUser('buyer3');
    const reviewId = await publishPaid(200);
    const c = await login(buyer.email);
    const before = await balance(authorId);
    expect((await c.post(`/api/reviews/${reviewId}/purchase`, {})).statusCode).toBe(201);
    const again = await c.post(`/api/reviews/${reviewId}/purchase`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_purchased');
    expect(await balance(authorId)).toBe(before + 180);
    expect(ctx.payments.charges.size).toBeGreaterThan(0);
  });

  it('同時に2回送られても、課金・計上は1回だけ', async () => {
    const buyer = await newUser('buyer4');
    const reviewId = await publishPaid(300);
    const c = await login(buyer.email);
    const chargesBefore = ctx.payments.charges.size;
    const before = await balance(authorId);
    const results = await Promise.all([c.post(`/api/reviews/${reviewId}/purchase`, {}), c.post(`/api/reviews/${reviewId}/purchase`, {})]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(ctx.payments.charges.size - chargesBefore).toBe(1);
    expect(await balance(authorId)).toBe(before + 270);
  });

  it('決済が失敗したら購入は成立せず、全文も見えず、売上も付かない。その後は再購入できる', async () => {
    const buyer = await newUser('buyer5');
    const reviewId = await publishPaid(300);
    const c = await login(buyer.email);
    const before = await balance(authorId);
    ctx.payments.failNextCharge = true;
    const fail = await c.post(`/api/reviews/${reviewId}/purchase`, {});
    expect(fail.statusCode).toBe(402);
    expect(await balance(authorId)).toBe(before);
    const page = await c.get('/api/therapists/kai');
    expect(page.body).not.toContain(SECRET_TAIL);
    expect((await c.post(`/api/reviews/${reviewId}/purchase`, {})).statusCode).toBe(201);
  });

  it('自分の口コミ・無料の口コミ・未公開の口コミは購入できない', async () => {
    const seller = await login('seller@example.com');
    const mine = await publishPaid(300);
    const own = await seller.post(`/api/reviews/${mine}/purchase`, {});
    expect(own.statusCode).toBe(400);
    expect(own.json().error).toBe('own_review');

    const buyer = await newUser('buyer6');
    const c = await login(buyer.email);
    const free = randomUUID();
    await ctx.db.query(
      `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,body,status,published_at)
       VALUES ($1,$2,$3,'this_month',90,'on_booking','matched',5,5,5,'無料の内容','published',now())`, [free, authorId, therapistId]);
    expect((await c.post(`/api/reviews/${free}/purchase`, {})).json().error).toBe('not_for_sale');

    const pending = randomUUID();
    await ctx.db.query(
      `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,body,listing_kind,price_yen,status)
       VALUES ($1,$2,$3,'this_month',90,'on_booking','matched',5,5,5,'審査中','paid',300,'pending')`, [pending, authorId, therapistId]);
    expect((await c.post(`/api/reviews/${pending}/purchase`, {})).statusCode).toBe(404);
  });

  it('未ログインは購入できない', async () => {
    const reviewId = await publishPaid(100);
    expect((await new Client(ctx.app).post(`/api/reviews/${reviewId}/purchase`, {})).statusCode).toBe(401);
  });
});

describe('返金', () => {
  async function buy(tag: string, price = 300) {
    const buyer = await newUser(tag);
    const reviewId = await publishPaid(price);
    const c = await login(buyer.email);
    const purchaseId = (await c.post(`/api/reviews/${reviewId}/purchase`, {})).json().purchaseId as string;
    return { c, reviewId, purchaseId, buyerId: buyer.id };
  }

  it('申請→承認で、全額返金・全文ロック・投稿者の売上が差し引かれる', async () => {
    const { c, reviewId, purchaseId } = await buy('refund1');
    const before = await balance(authorId);
    const req = await c.post(`/api/purchases/${purchaseId}/refund-request`, { reason: '内容が規約に反していた' });
    expect(req.statusCode).toBe(201);

    await newUser('mod-r1', 'moderator');
    const mod = await login('mod-r1@example.com');
    const queue = (await mod.get('/api/admin/refunds')).json().items;
    const item = queue.find((i: { purchaseId: string }) => i.purchaseId === purchaseId);
    expect(item).toBeTruthy();
    const ok = await mod.post(`/api/admin/refunds/${item.id}/decide`, { decision: 'approve' });
    expect(ok.json()).toEqual({ status: 'approved' });

    expect((await ctx.db.query<{ status: string }>('SELECT status FROM purchases WHERE id=$1', [purchaseId])).rows[0]!.status).toBe('refunded');
    expect(await balance(authorId)).toBe(before - 270);
    const page = await c.get('/api/therapists/kai');
    expect(page.body).not.toContain(SECRET_TAIL);
    expect([...ctx.payments.charges.values()].some((x) => x.refunded)).toBe(true);
    // 返金後は再購入できる
    expect((await c.post(`/api/reviews/${reviewId}/purchase`, {})).statusCode).toBe(201);
  });

  it('二重承認しても返金・差し引きは1回だけ', async () => {
    const { c, purchaseId } = await buy('refund2');
    await c.post(`/api/purchases/${purchaseId}/refund-request`, { reason: 'テスト' });
    const mod = await login('mod-r1@example.com');
    const item = (await mod.get('/api/admin/refunds')).json().items.find((i: { purchaseId: string }) => i.purchaseId === purchaseId);
    const before = await balance(authorId);
    const [a, b] = await Promise.all([
      mod.post(`/api/admin/refunds/${item.id}/decide`, { decision: 'approve' }),
      mod.post(`/api/admin/refunds/${item.id}/decide`, { decision: 'approve' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await balance(authorId)).toBe(before - 270);
  });

  it('却下すると購入は有効のまま', async () => {
    const { c, purchaseId } = await buy('refund3');
    await c.post(`/api/purchases/${purchaseId}/refund-request`, { reason: 'テスト' });
    const mod = await login('mod-r1@example.com');
    const item = (await mod.get('/api/admin/refunds')).json().items.find((i: { purchaseId: string }) => i.purchaseId === purchaseId);
    expect((await mod.post(`/api/admin/refunds/${item.id}/decide`, { decision: 'deny' })).json()).toEqual({ status: 'denied' });
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM purchases WHERE id=$1', [purchaseId])).rows[0]!.status).toBe('completed');
  });

  it('決済側の返金に失敗したら、何も変わらず（返金済みにも差し引きにもならず）再試行できる', async () => {
    const { c, purchaseId } = await buy('refund4');
    await c.post(`/api/purchases/${purchaseId}/refund-request`, { reason: 'テスト' });
    const mod = await login('mod-r1@example.com');
    const item = (await mod.get('/api/admin/refunds')).json().items.find((i: { purchaseId: string }) => i.purchaseId === purchaseId);
    const before = await balance(authorId);
    ctx.payments.failNextRefund = true;
    const fail = await mod.post(`/api/admin/refunds/${item.id}/decide`, { decision: 'approve' });
    expect(fail.statusCode).toBe(502);
    expect((await ctx.db.query<{ status: string }>('SELECT status FROM purchases WHERE id=$1', [purchaseId])).rows[0]!.status).toBe('completed');
    expect(await balance(authorId)).toBe(before);
    expect((await mod.post(`/api/admin/refunds/${item.id}/decide`, { decision: 'approve' })).statusCode).toBe(200);
  });

  it('他人の購入には申請できず、二重申請と期限切れも拒否される', async () => {
    const { c, purchaseId } = await buy('refund5');
    const other = await newUser('stranger-r');
    const o = await login(other.email);
    expect((await o.post(`/api/purchases/${purchaseId}/refund-request`, { reason: 'x' })).statusCode).toBe(404);

    expect((await c.post(`/api/purchases/${purchaseId}/refund-request`, { reason: 'x' })).statusCode).toBe(201);
    expect((await c.post(`/api/purchases/${purchaseId}/refund-request`, { reason: 'x' })).json().error).toBe('already_requested');

    const old = await buy('refund6');
    await ctx.db.query(`UPDATE purchases SET created_at = now() - interval '73 hours' WHERE id=$1`, [old.purchaseId]);
    const late = await old.c.post(`/api/purchases/${old.purchaseId}/refund-request`, { reason: 'x' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('window_closed');
  });

  it('一般ユーザーは返金の判断をできない', async () => {
    const { c } = await buy('refund7');
    expect((await c.get('/api/admin/refunds')).statusCode).toBe(403);
  });
});

describe('出金', () => {
  it('残高が最低額未満だと申請できない', async () => {
    const u = await newUser('poor');
    const c = await login(u.email);
    const res = await c.post('/api/me/payouts', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('below_minimum');
  });

  async function earn(uid: string, yen: number) {
    await ctx.db.query(`INSERT INTO ledger_entries (id,user_id,amount_yen,kind,ref_id) VALUES ($1,$2,$3,'sale',$4)`, [randomUUID(), uid, yen, randomUUID()]);
  }

  it('申請すると残高が引き当てられ、並行・二重申請はできない', async () => {
    const u = await newUser('earner1');
    await earn(u.id, 2700);
    const c = await login(u.email);
    const [a, b] = await Promise.all([c.post('/api/me/payouts', {}), c.post('/api/me/payouts', {})]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 400]);
    expect(await balance(u.id)).toBe(0);
    expect((await ctx.db.query('SELECT 1 FROM payout_requests WHERE user_id=$1', [u.id])).rowCount).toBe(1);
  });

  it('管理者が支払済みにする。モデレーターは出金を扱えない', async () => {
    const u = await newUser('earner2');
    await earn(u.id, 1500);
    await (await login(u.email)).post('/api/me/payouts', {});

    const mod = await login('mod-r1@example.com');
    expect((await mod.get('/api/admin/payouts')).statusCode).toBe(403);

    await newUser('admin-p', 'admin');
    const admin = await login('admin-p@example.com');
    const item = (await admin.get('/api/admin/payouts')).json().items.find((i: { nickname: string }) => i.nickname === 'earner2');
    expect(item.amountYen).toBe(1500);
    expect((await mod.post(`/api/admin/payouts/${item.id}/decide`, { decision: 'paid' })).statusCode).toBe(403);
    expect((await admin.post(`/api/admin/payouts/${item.id}/decide`, { decision: 'paid' })).json()).toEqual({ status: 'paid' });
    expect(await balance(u.id)).toBe(0);
    expect((await admin.post(`/api/admin/payouts/${item.id}/decide`, { decision: 'paid' })).statusCode).toBe(409);
  });

  it('却下すると残高に戻る', async () => {
    const u = await newUser('earner3');
    await earn(u.id, 1200);
    await (await login(u.email)).post('/api/me/payouts', {});
    expect(await balance(u.id)).toBe(0);
    const admin = await login('admin-p@example.com');
    const item = (await admin.get('/api/admin/payouts')).json().items.find((i: { nickname: string }) => i.nickname === 'earner3');
    await admin.post(`/api/admin/payouts/${item.id}/decide`, { decision: 'denied' });
    expect(await balance(u.id)).toBe(1200);
  });

  it('出金の受付を無効にすると、残高があっても申請できず残高も動かない', async () => {
    const off = await makeApp({ PAYOUTS_ENABLED: 'false' });
    try {
      const id = await createVerifiedUser(off.db, { email: 'rich@example.com', nickname: 'rich', password: PW });
      await off.db.query(`INSERT INTO ledger_entries (id,user_id,amount_yen,kind,ref_id) VALUES ($1,$2,5000,'sale',$3)`, [randomUUID(), id, randomUUID()]);
      const c = new Client(off.app); await c.loginAs('rich@example.com', PW);
      const res = await c.post('/api/me/payouts', {});
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('payouts_disabled');
      expect((await c.get('/api/me/summary')).json()).toMatchObject({ balanceYen: 5000, payoutsEnabled: false });
    } finally { await off.close(); }
  });

  it('本番の既定では出金は無効', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', BASE_URL: 'https://example.com', SESSION_SECRET: 'x'.repeat(40), SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'no-reply@example.com' };
    expect(loadConfig(base as NodeJS.ProcessEnv).payoutsEnabled).toBe(false);
    expect(loadConfig({ ...base, PAYOUTS_ENABLED: 'true' } as NodeJS.ProcessEnv).payoutsEnabled).toBe(true);
  });

  it('返金で残高がマイナスになっても出金はできない（のちの売上で相殺される）', async () => {
    const u = await newUser('negative');
    await earn(u.id, -270);
    const c = await login(u.email);
    expect((await c.post('/api/me/payouts', {})).json().error).toBe('below_minimum');
  });
});

describe('マイページ集計と通報', () => {
  it('書いた口コミごとの販売数・受け取り額が返る', async () => {
    const seller = await newUser('seller-stats');
    const rid = await publishPaid(300, seller.id);
    const b1 = await newUser('stat-b1'), b2 = await newUser('stat-b2');
    for (const b of [b1, b2]) await (await login(b.email)).post(`/api/reviews/${rid}/purchase`, {});
    const mine = (await (await login(seller.email)).get('/api/me/reviews')).json().reviews;
    const r = mine.find((x: { id: string }) => x.id === rid);
    expect(r).toMatchObject({ soldCount: 2, soldNetYen: 540, therapistSlug: 'kai' });
  });

  it('今月の売上・手数料・残高が元帳と一致する', async () => {
    const c = await login('seller@example.com');
    const s = (await c.get('/api/me/summary')).json();
    expect(s.balanceYen).toBe(await balance(authorId));
    expect(s.feePercent).toBe(10);
    expect(s.monthNetYen + s.monthFeeYen).toBeGreaterThan(0);
  });

  it('通報を非公開付きで閉じると、口コミが担当者ページから消える', async () => {
    const reviewId = await publishPaid(300);
    const u = await newUser('reporter1');
    const rc = await login(u.email);
    await rc.post(`/api/reviews/${reviewId}/report`, { reason: '規約違反の疑い' });
    const mod = await login('mod-r1@example.com');
    const item = (await mod.get('/api/admin/reports')).json().items.find((i: { reviewId: string }) => i.reviewId === reviewId);
    expect(item).toBeTruthy();
    expect((await mod.post(`/api/admin/reports/${item.id}/close`, { unpublish: true })).json()).toEqual({ ok: true });
    const page = (await new Client(ctx.app).get('/api/therapists/kai')).json();
    expect(page.reviews.some((r: { id: string }) => r.id === reviewId)).toBe(false);
  });
});

describe('決済が無効のとき', () => {
  it('購入は503になり、何も記録されない', async () => {    const { DisabledPaymentProvider } = await import('../src/payments/provider.js');
    const off = await makeApp({ PAYMENT_PROVIDER: 'disabled' });
    try {
      const sellerId = await createVerifiedUser(off.db, { email: 's@example.com', nickname: 'sx', password: PW });
      await createVerifiedUser(off.db, { email: 'b@example.com', nickname: 'bx', password: PW });
      const th = (await off.db.query<{ id: string }>(`SELECT id FROM therapists LIMIT 1`)).rows[0]!;
      const rid = randomUUID();
      await off.db.query(
        `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,body,listing_kind,price_yen,status,published_at)
         VALUES ($1,$2,$3,'this_month',90,'on_booking','matched',5,5,5,'本文','paid',300,'published',now())`, [rid, sellerId, th.id]);
      // 無効プロバイダに差し替えたアプリで検証
      const { buildApp } = await import('../src/app.js');
      const { loadConfig } = await import('../src/config.js');
      const { DisabledPointsProvider } = await import('../src/payments/provider.js');
      const { join } = await import('node:path');
      const app = await buildApp({ config: loadConfig({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'disabled', AUTH_RATE_LIMIT_MAX: '1000' } as NodeJS.ProcessEnv), db: off.db, mailer: off.mailer, publicDir: join(process.cwd(), 'public'), payments: new DisabledPaymentProvider(), pointsProvider: new DisabledPointsProvider() });
      await app.ready();
      const c = new Client(app); await c.loginAs('b@example.com', PW);
      const res = await c.post(`/api/reviews/${rid}/purchase`, {});
      expect(res.statusCode).toBe(503);
      expect((await off.db.query(`SELECT 1 FROM ledger_entries`)).rowCount).toBe(0);
      expect((await off.db.query(`SELECT 1 FROM purchases WHERE status='completed'`)).rowCount).toBe(0);
      await app.close();
    } finally { await off.close(); }
  });

  it('本番設定で stub を指定すると起動できない', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', BASE_URL: 'https://example.com', SESSION_SECRET: 'x'.repeat(40), SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'no-reply@example.com' };
    expect(() => loadConfig({ ...base, PAYMENT_PROVIDER: 'stub' } as NodeJS.ProcessEnv)).toThrow();
    expect(loadConfig(base as NodeJS.ProcessEnv).paymentProvider).toBe('disabled');
  });

  it('GET /api/config は決済プロバイダに応じて salesEnabled を返す', async () => {
    // 既定のテスト環境は points=stub（販売可）
    expect((await new Client(ctx.app).get('/api/config')).json()).toEqual({ salesEnabled: true, pointsEnabled: true });
    // POINTS_PROVIDER=disabled のアプリでは salesEnabled=false（＝有料導線は後日公開）
    const off = await makeApp({ POINTS_PROVIDER: 'disabled' });
    try {
      expect((await new Client(off.app).get('/api/config')).json()).toEqual({ salesEnabled: false, pointsEnabled: false });
    } finally { await off.close(); }
  });
});

describe('メール設定（SMTP）', () => {
  const prodBase = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', BASE_URL: 'https://example.com', SESSION_SECRET: 'x'.repeat(40) };

  it('本番で SMTP 未設定だと起動できない', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig(prodBase as NodeJS.ProcessEnv)).toThrow();
  });

  it('SMTP_HOST はあるが MAIL_FROM が無いと起動できない（誤送信防止）', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig({ ...prodBase, SMTP_HOST: 'smtp.example.com' } as NodeJS.ProcessEnv)).toThrow();
  });

  it('SMTP_HOST と MAIL_FROM が揃えば smtp 設定が組み立てられる', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({ ...prodBase, SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'Hodoku <no-reply@example.com>' } as NodeJS.ProcessEnv);
    expect(cfg.smtp).toEqual({ host: 'smtp.example.com', port: 465, secure: true, user: 'u', pass: 'p', from: 'Hodoku <no-reply@example.com>' });
  });

  it('開発では SMTP 未設定でも起動でき smtp は null', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).smtp).toBeNull();
  });
});
