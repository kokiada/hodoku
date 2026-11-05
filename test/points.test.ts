import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, makeApp, createVerifiedUser, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let authorId: string, therapistId: string;
const PW = 'password-123';
const SECRET_TAIL = '購入後にだけ読める後半の本文です';

async function newUser(tag: string) {
  const email = `${tag}@example.com`;
  const id = await createVerifiedUser(ctx.db, { email, nickname: tag, password: PW });
  return { id, email };
}
async function login(email: string) { const c = new Client(ctx.app); await c.loginAs(email, PW); return c; }
async function publishPaid(price: number): Promise<string> {
  const id = randomUUID();
  await ctx.db.query(
    `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,
       body,listing_kind,price_yen,usage_verified,status,published_at)
     VALUES ($1,$2,$3,'this_month',90,'on_booking','matched',5,5,5,$4,'paid',$5,true,'published',now())`,
    [id, authorId, therapistId, 'あ'.repeat(70) + SECRET_TAIL, price],
  );
  return id;
}

/** スタブのチャージを「決済完了」させる（Webフックを自前で投げる） */
async function completeCharge(c: Client, chargeId: string) {
  const providerRef = (await ctx.db.query<{ provider_ref: string }>('SELECT provider_ref FROM point_charges WHERE id=$1', [chargeId])).rows[0]!.provider_ref;
  const body = ctx.points.completedWebhookBody(chargeId, providerRef);
  // Webフックは CSRF 対象外。生のJSONを送る
  return c.post('/api/points/webhook/bitcash', JSON.parse(body));
}

beforeAll(async () => {
  ctx = await makeApp();
  authorId = (await newUser('pt-seller')).id;
  therapistId = (await ctx.db.query<{ id: string }>(`SELECT id FROM therapists WHERE slug='kai'`)).rows[0]!.id;
});
afterAll(async () => { await ctx.close(); });

describe('ポイントのチャージ', () => {
  it('パック一覧に 500円→400pt と 2000円→1800pt と おすすめの1万円がある', async () => {
    const packs = (await new Client(ctx.app).get('/api/points/packs')).json().packs as Array<{ yen: number; points: number; recommended?: boolean }>;
    expect(packs.find((p) => p.yen === 500)).toMatchObject({ yen: 500, points: 400 });
    expect(packs.find((p) => p.yen === 2000)).toMatchObject({ yen: 2000, points: 1800 });
    expect(packs.find((p) => p.yen === 10000)).toMatchObject({ yen: 10000, points: 10100, recommended: true });
  });

  it('チャージ→Webフック確定でポイントが付与される。金額・ポイントはサーバーが決める', async () => {
    const u = await newUser('pt-charger');
    const c = await login(u.email);
    const begin = await c.post('/api/points/charge', { packYen: 2000 });
    expect(begin.statusCode).toBe(201);
    expect(begin.json().amountPt).toBe(1800);
    const chargeId = begin.json().chargeId as string;

    // 確定前は残高0
    expect((await c.get('/api/me/points')).json().balancePt).toBe(0);
    // Webフックで確定
    expect((await completeCharge(c, chargeId)).statusCode).toBe(200);
    expect((await c.get('/api/me/points')).json().balancePt).toBe(1800);
  });

  it('クライアントが送った不正な額は拒否される（パック定義のみ有効）', async () => {
    const u = await newUser('pt-bad');
    const c = await login(u.email);
    expect((await c.post('/api/points/charge', { packYen: 1234 })).statusCode).toBe(400);
  });

  it('同じWebフックを二重に受けても、二重付与されない（冪等）', async () => {
    const u = await newUser('pt-dup');
    const c = await login(u.email);
    const chargeId = (await c.post('/api/points/charge', { packYen: 1000 })).json().chargeId as string;
    await completeCharge(c, chargeId);
    await completeCharge(c, chargeId); // 2回目
    expect((await c.get('/api/me/points')).json().balancePt).toBe(900);
    expect((await ctx.db.query('SELECT 1 FROM point_ledger WHERE ref_id=$1', [chargeId])).rowCount).toBe(1);
  });
});

describe('ポイントでの口コミ閲覧', () => {
  it('解放前は冒頭だけ、解放後は全文が読める。ポイントが消費される', async () => {
    const u = await newUser('pt-reader');
    const c = await login(u.email);
    // 2000円チャージ（1800pt）
    const chargeId = (await c.post('/api/points/charge', { packYen: 2000 })).json().chargeId as string;
    await completeCharge(c, chargeId);

    const reviewId = await publishPaid(300);
    // 解放前：本文はプレビューのみ
    let page = (await c.get('/api/therapists/kai')).json();
    expect(page.reviews.find((r: { id: string }) => r.id === reviewId).body).not.toContain(SECRET_TAIL);

    // 解放（300pt 消費）
    const unlock = await c.post(`/api/reviews/${reviewId}/unlock`, {});
    expect(unlock.statusCode).toBe(200);
    expect(unlock.json().spentPt).toBe(300);
    expect(unlock.json().balancePt).toBe(1500);

    // 解放後：全文
    page = (await c.get('/api/therapists/kai')).json();
    expect(page.reviews.find((r: { id: string }) => r.id === reviewId).body).toContain(SECRET_TAIL);
    expect((await c.get('/api/me/points')).json().balancePt).toBe(1500);
  });

  it('残高不足なら402で解放できず、ポイントも減らない', async () => {
    const u = await newUser('pt-poor');
    const c = await login(u.email);
    const chargeId = (await c.post('/api/points/charge', { packYen: 500 })).json().chargeId as string; // 400pt
    await completeCharge(c, chargeId);
    const reviewId = await publishPaid(500); // 500pt 必要
    const res = await c.post(`/api/reviews/${reviewId}/unlock`, {});
    expect(res.statusCode).toBe(402);
    expect((await c.get('/api/me/points')).json().balancePt).toBe(400);
  });

  it('同じ口コミを二重解放しても、消費は1回だけ（冪等）', async () => {
    const u = await newUser('pt-twice');
    const c = await login(u.email);
    const chargeId = (await c.post('/api/points/charge', { packYen: 2000 })).json().chargeId as string;
    await completeCharge(c, chargeId);
    const reviewId = await publishPaid(300);
    await c.post(`/api/reviews/${reviewId}/unlock`, {});
    const again = await c.post(`/api/reviews/${reviewId}/unlock`, {});
    expect(again.statusCode).toBe(200);
    expect(again.json().spentPt).toBe(0); // 2回目は消費なし
    expect((await c.get('/api/me/points')).json().balancePt).toBe(1500);
  });

  it('自分の口コミは解放不要（400）', async () => {
    const c = await login('pt-seller@example.com');
    const reviewId = await publishPaid(300);
    expect((await c.post(`/api/reviews/${reviewId}/unlock`, {})).statusCode).toBe(400);
  });

  it('未ログインは解放できない', async () => {
    const reviewId = await publishPaid(300);
    expect((await new Client(ctx.app).post(`/api/reviews/${reviewId}/unlock`, {})).statusCode).toBe(401);
  });
});

describe('チャージ無効のとき', () => {
  it('POINTS_PROVIDER=disabled ではチャージ開始が503、/api/config も無効を返す', async () => {
    const off = await makeApp({ POINTS_PROVIDER: 'disabled' });
    try {
      const u = randomUUID();
      await createVerifiedUser(off.db, { email: 'off@example.com', nickname: 'offuser', password: PW });
      const c = new Client(off.app); await c.loginAs('off@example.com', PW);
      expect((await c.post('/api/points/charge', { packYen: 2000 })).statusCode).toBe(503);
      expect((await c.get('/api/config')).json()).toEqual({ salesEnabled: false, pointsEnabled: false });
      void u;
    } finally { await off.close(); }
  });
});
