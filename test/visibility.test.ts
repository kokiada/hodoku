import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createVerifiedUser, makeApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
const SECRET_TAIL = 'この後半部分は購入者にしか見せない秘密の本文です';
const FULL = 'あ'.repeat(60) + SECRET_TAIL;
let paidId: string, authorId: string, buyerId: string;

beforeAll(async () => {
  ctx = await makeApp();
  authorId = await createVerifiedUser(ctx.db, { email: 'author@example.com', nickname: 'paidauthor', password: 'password-123' });
  buyerId = await createVerifiedUser(ctx.db, { email: 'buyer@example.com', nickname: 'buyer', password: 'password-123' });
  await createVerifiedUser(ctx.db, { email: 'stranger@example.com', nickname: 'stranger', password: 'password-123' });
  await createVerifiedUser(ctx.db, { email: 'mod@example.com', nickname: 'moderator1', password: 'password-123', role: 'moderator' });
  const therapist = (await ctx.db.query<{ id: string }>(`SELECT id FROM therapists WHERE slug='kai'`)).rows[0]!;
  paidId = randomUUID();
  await ctx.db.query(
    `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,
       body,listing_kind,price_yen,usage_verified,status,published_at)
     VALUES ($1,$2,$3,'this_month',90,'on_booking','matched',5,5,5,$4,'paid',300,true,'published',now())`,
    [paidId, authorId, therapist.id, FULL],
  );
});
afterAll(async () => { await ctx.close(); });

const bodyOf = (res: { json(): { reviews: Array<{ id: string; body: string; locked: boolean }> } }) => res.json().reviews.find((r) => r.id === paidId)!;

describe('有料口コミの本文は権限のある人にしか返さない', () => {
  it('未ログインには冒頭50字だけで、秘密の後半は応答のどこにも含まれない', async () => {
    const res = await new Client(ctx.app).get('/api/therapists/kai');
    const r = bodyOf(res);
    expect(r.locked).toBe(true);
    expect(Array.from(r.body)).toHaveLength(50);
    expect(res.body).not.toContain(SECRET_TAIL);
  });

  it('未購入のログインユーザーにも見せない', async () => {
    const c = new Client(ctx.app); await c.loginAs('stranger@example.com', 'password-123');
    const res = await c.get('/api/therapists/kai');
    expect(bodyOf(res).locked).toBe(true);
    expect(res.body).not.toContain(SECRET_TAIL);
  });

  it('投稿者本人とモデレーターには全文を見せる', async () => {
    for (const email of ['author@example.com', 'mod@example.com']) {
      const c = new Client(ctx.app); await c.loginAs(email, 'password-123');
      const r = bodyOf(await c.get('/api/therapists/kai'));
      expect(r.locked, email).toBe(false);
      expect(r.body).toContain(SECRET_TAIL);
    }
  });

  it('購入済み（完了）の人には全文、返金済みになると再びロックされる', async () => {
    const pid = randomUUID();
    await ctx.db.query(`INSERT INTO purchases (id,review_id,buyer_id,price_yen,fee_yen,author_net_yen,status) VALUES ($1,$2,$3,300,30,270,'completed')`, [pid, paidId, buyerId]);
    const c = new Client(ctx.app); await c.loginAs('buyer@example.com', 'password-123');
    expect(bodyOf(await c.get('/api/therapists/kai')).body).toContain(SECRET_TAIL);
    await ctx.db.query(`UPDATE purchases SET status='refunded' WHERE id=$1`, [pid]);
    const res = await c.get('/api/therapists/kai');
    expect(bodyOf(res).locked).toBe(true);
    expect(res.body).not.toContain(SECRET_TAIL);
  });

  it('審査待ち・非公開の口コミは担当者ページにそもそも出ない', async () => {
    const th = (await ctx.db.query<{ id: string }>(`SELECT id FROM therapists WHERE slug='kai'`)).rows[0]!;
    for (const status of ['pending', 'rejected', 'changes_requested']) {
      await ctx.db.query(
        `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,body,status)
         VALUES ($1,$2,$3,'this_month',90,'on_booking','matched',3,3,3,$4,$5)`,
        [randomUUID(), authorId, th.id, `hidden-${status}-body`, status],
      );
    }
    const res = await new Client(ctx.app).get('/api/therapists/kai');
    for (const status of ['pending', 'rejected', 'changes_requested']) expect(res.body).not.toContain(`hidden-${status}-body`);
  });
});
