import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createVerifiedUser, makeApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => { ctx = await makeApp(); });
afterAll(async () => { await ctx.close(); });

describe('店舗一覧・検索', () => {
  it('90分の総額がモックと同じ値で返る', async () => {
    const res = await new Client(ctx.app).get('/api/shops?minutes=90');
    const lumen = res.json().shops.find((s: { name: string }) => s.name === 'Atelier Lumen');
    expect(lumen.totalYen).toBe(18400);
  });

  it('駅・条件・予算で絞り込める', async () => {
    const c = new Client(ctx.app);
    const byStation = (await c.get('/api/shops?station=代官山')).json().shops;
    expect(byStation.every((s: { station: string }) => s.station === '代官山')).toBe(true);
    const byDesk = (await c.get('/api/shops?flags=desk')).json().shops;
    expect(byDesk.every((s: { hasSupportDesk: boolean }) => s.hasSupportDesk)).toBe(true);
    const byBudget = (await c.get('/api/shops?budget=16000')).json().shops;
    expect(byBudget.every((s: { totalYen: number }) => s.totalYen <= 16000)).toBe(true);
  });

  it('総額が安い順に並ぶ', async () => {
    const shops = (await new Client(ctx.app).get('/api/shops?sort=total')).json().shops;
    const totals = shops.map((s: { totalYen: number }) => s.totalYen);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
  });

  it('店舗詳細に内訳・担当者が入る', async () => {
    const res = await new Client(ctx.app).get('/api/shops/atelier-lumen?minutes=90');
    const shop = res.json().shop;
    expect(shop.breakdown.course + shop.breakdown.nomination + shop.breakdown.transport).toBe(shop.totalYen);
    expect(shop.therapists.some((t: { slug: string }) => t.slug === 'kai')).toBe(true);
  });

  it('最終確認日は YYYY-MM-DD の文字列で返る（日付型が文字列化で壊れない）', async () => {
    const shops = (await new Client(ctx.app).get('/api/shops')).json().shops as Array<{ lastCheckedAt: string | null }>;
    expect(shops.length).toBeGreaterThan(0);
    for (const s of shops) expect(s.lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const detail = (await new Client(ctx.app).get('/api/shops/salon-veil')).json().shop;
    expect(detail.lastCheckedAt).toBe('2026-09-12');
  });

  it('存在しない店舗は404', async () => {
    expect((await new Client(ctx.app).get('/api/shops/does-not-exist')).statusCode).toBe(404);
  });
});

describe('人からさがす（担当者一覧）', () => {
  it('公開中の担当者を店舗横断で返す。口コミ数・信頼度・店舗情報が付く', async () => {
    const list = (await new Client(ctx.app).get('/api/therapists')).json().therapists as Array<{ slug: string; name: string; shopName: string; station: string; reviewCount: number; trust: string }>;
    expect(list.length).toBeGreaterThan(0);
    const kai = list.find((t) => t.slug === 'kai');
    expect(kai).toBeTruthy();
    expect(kai!.shopName).toBeTruthy();
    expect(typeof kai!.reviewCount).toBe('number');
    expect(['high', 'mid', 'low']).toContain(kai!.trust);
  });

  it('口コミが多い順（話題）で並ぶ', async () => {
    const list = (await new Client(ctx.app).get('/api/therapists?sort=reviews')).json().therapists as Array<{ reviewCount: number }>;
    const counts = list.map((t) => t.reviewCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('駅・キーワードで絞り込める', async () => {
    const c = new Client(ctx.app);
    const all = (await c.get('/api/therapists')).json().therapists as Array<{ station: string }>;
    const station = all[0]!.station;
    const byStation = (await c.get(`/api/therapists?station=${encodeURIComponent(station)}`)).json().therapists as Array<{ station: string }>;
    expect(byStation.every((t) => t.station === station)).toBe(true);
    // 一致しないキーワードは0件
    const none = (await c.get('/api/therapists?q=存在しないキーワードxyz')).json().therapists;
    expect(none.length).toBe(0);
  });
});

describe('削除・訂正の依頼', () => {
  it('必須項目がそろえば受付され、監査ログに記録される', async () => {
    const c = new Client(ctx.app);
    const res = await c.post('/api/removal-request', { url: 'https://example.com/therapist?slug=kai', kind: 'rights', email: 'who@example.com', detail: '権利侵害の申し立て' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const row = (await ctx.db.query<{ action: string; target: string }>(`SELECT action, target FROM audit_log WHERE action='removal_request' ORDER BY at DESC LIMIT 1`)).rows[0]!;
    expect(row.action).toBe('removal_request');
    expect(row.target).toContain('slug=kai');
  });

  it('不正な入力（URLでない・種別不正）は400', async () => {
    const c = new Client(ctx.app);
    expect((await c.post('/api/removal-request', { url: 'not-a-url', kind: 'rights', email: 'a@example.com', detail: 'x' })).statusCode).toBe(400);
    expect((await c.post('/api/removal-request', { url: 'https://example.com/x', kind: 'bogus', email: 'a@example.com', detail: 'x' })).statusCode).toBe(400);
  });
});

describe('口コミ投稿と担当者ページ', () => {
  const freeBody = {
    therapistSlug: 'kai', visitedWhen: 'this_month', courseMinutes: 90, ngPrecheck: 'on_booking', totalMatched: 'matched',
    scoreCare: 5, scoreComfort: 4, scorePunctual: 5, giftReceived: false, body: '時間どおりで、落ち着いて過ごせました。',
    listing: { kind: 'free' },
  };

  it('ログインしていないと投稿できない', async () => {
    expect((await new Client(ctx.app).post('/api/reviews', freeBody)).statusCode).toBe(401);
  });

  it('18歳未満を連想させる表現は拒否される', async () => {
    await createVerifiedUser(ctx.db, { email: 'kid-check@example.com', nickname: 'kidcheck', password: 'password-123' });
    const c = new Client(ctx.app); await c.loginAs('kid-check@example.com', 'password-123');
    const res = await c.post('/api/reviews', { ...freeBody, body: '未成年のような雰囲気の方でした' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('forbidden_content');
  });

  it('短文・特典ありは有料にできない', async () => {
    await createVerifiedUser(ctx.db, { email: 'short@example.com', nickname: 'shortbody', password: 'password-123' });
    const c = new Client(ctx.app); await c.loginAs('short@example.com', 'password-123');
    const res = await c.post('/api/reviews', { ...freeBody, body: '短い感想です', listing: { kind: 'paid', priceYen: 300 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('paid_not_allowed');

    await createVerifiedUser(ctx.db, { email: 'gift@example.com', nickname: 'giftuser', password: 'password-123' });
    const c2 = new Client(ctx.app); await c2.loginAs('gift@example.com', 'password-123');
    const longBody = 'とても丁寧な対応で、予約から当日までの流れもわかりやすく説明してもらいました。'.repeat(2);
    const res2 = await c2.post('/api/reviews', { ...freeBody, giftReceived: true, body: longBody, listing: { kind: 'paid', priceYen: 300 } });
    expect(res2.json().error).toBe('paid_not_allowed');
  });

  it('同じ担当者に30日以内の重複投稿、1日3件超は拒否される', async () => {
    await createVerifiedUser(ctx.db, { email: 'dup@example.com', nickname: 'dupuser', password: 'password-123' });
    const c = new Client(ctx.app); await c.loginAs('dup@example.com', 'password-123');
    expect((await c.post('/api/reviews', freeBody)).statusCode).toBe(201);
    const res = await c.post('/api/reviews', freeBody);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('duplicate_recent');

    await createVerifiedUser(ctx.db, { email: 'limit@example.com', nickname: 'limituser', password: 'password-123' });
    const c2 = new Client(ctx.app); await c2.loginAs('limit@example.com', 'password-123');
    for (const slug of ['kai', 'ren', 'itsuki']) {
      expect((await c2.post('/api/reviews', { ...freeBody, therapistSlug: slug })).statusCode).toBe(201);
    }
    const over = await c2.post('/api/reviews', { ...freeBody, therapistSlug: 'sora' });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe('daily_limit');
  });

  it('投稿は審査待ちで、公開されるまで担当者ページに出ない', async () => {
    await createVerifiedUser(ctx.db, { email: 'queued@example.com', nickname: 'queueduser', password: 'password-123' });
    const c = new Client(ctx.app); await c.loginAs('queued@example.com', 'password-123');
    await c.post('/api/reviews', { ...freeBody, therapistSlug: 'ren', body: '独自の内容その1：予約から当日までとても丁寧でした。' });
    const page = (await c.get('/api/therapists/ren')).json();
    expect(page.reviews.some((r: { authorNickname: string }) => r.authorNickname === 'queueduser')).toBe(false);
    const mine = (await c.get('/api/me/reviews')).json().reviews;
    expect(mine[0].status).toBe('pending');
  });
});

describe('審査キューと権限', () => {
  it('一般ユーザーはキューにアクセスできない', async () => {
    await createVerifiedUser(ctx.db, { email: 'plain@example.com', nickname: 'plainuser', password: 'password-123' });
    const c = new Client(ctx.app); await c.loginAs('plain@example.com', 'password-123');
    expect((await c.get('/api/admin/queue')).statusCode).toBe(403);
  });

  it('モデレーターは承認・差し戻し・非公開にでき、理由なしの差し戻しは拒否される', async () => {
    await createVerifiedUser(ctx.db, { email: 'author1@example.com', nickname: 'author1', password: 'password-123' });
    const author = new Client(ctx.app); await author.loginAs('author1@example.com', 'password-123');
    await author.post('/api/reviews', { ...freeBodyFor('author1'), therapistSlug: 'itsuki' });

    await createVerifiedUser(ctx.db, { email: 'mod1@example.com', nickname: 'mod1', password: 'password-123', role: 'moderator' });
    const mod = new Client(ctx.app); await mod.loginAs('mod1@example.com', 'password-123');
    const queue = (await mod.get('/api/admin/queue')).json().items;
    const target = queue.find((q: { authorNickname: string }) => q.authorNickname === 'author1');
    expect(target).toBeTruthy();

    const noReason = await mod.post(`/api/admin/reviews/${target.id}/moderate`, { decision: 'request_changes' });
    expect(noReason.statusCode).toBe(400);

    const ok = await mod.post(`/api/admin/reviews/${target.id}/moderate`, { decision: 'approve', reason: '', usageVerified: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('published');

    const again = await mod.post(`/api/admin/reviews/${target.id}/moderate`, { decision: 'reject', reason: '二重審査' });
    expect(again.statusCode).toBe(409);
  });

  it('有料出品の条件を満たさないまま承認しようとすると拒否される', async () => {
    await createVerifiedUser(ctx.db, { email: 'author2@example.com', nickname: 'author2', password: 'password-123' });
    const author = new Client(ctx.app); await author.loginAs('author2@example.com', 'password-123');
    const longBody = 'とても丁寧な対応で、予約から当日までの流れもわかりやすく説明してもらいました。緊張していたのを察して、ゆっくり進めてもらえたので安心できました。総額も事前の案内どおりで、落ち着いて過ごせました。終わったあとの連絡もていねいで、また利用したいと感じました。';
    const submit = await author.post('/api/reviews', { ...freeBodyFor('author2'), therapistSlug: 'yui', body: longBody, listing: { kind: 'paid', priceYen: 300 } });
    expect(submit.statusCode, submit.body).toBe(201);

    await createVerifiedUser(ctx.db, { email: 'mod2@example.com', nickname: 'mod2', password: 'password-123', role: 'moderator' });
    const mod = new Client(ctx.app); await mod.loginAs('mod2@example.com', 'password-123');
    const queue = (await mod.get('/api/admin/queue')).json().items;
    const target = queue.find((q: { authorNickname: string }) => q.authorNickname === 'author2');
    expect(target.paidIneligible).toEqual(['利用が確認できていません']); // 投稿直後は利用未確認。モデレーターが確認して初めて有料にできる

    const res = await mod.post(`/api/admin/reviews/${target.id}/moderate`, { decision: 'approve', usageVerified: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('paid_not_eligible');

    const asFree = await mod.post(`/api/admin/reviews/${target.id}/moderate`, { decision: 'approve_free', usageVerified: false });
    expect(asFree.json()).toEqual({ status: 'published', listingKind: 'free' });
  });
});

function freeBodyFor(_tag: string) {
  return {
    therapistSlug: 'kai', visitedWhen: 'this_month', courseMinutes: 90, ngPrecheck: 'on_booking', totalMatched: 'matched',
    scoreCare: 5, scoreComfort: 4, scorePunctual: 5, giftReceived: false, body: '独自の内容その2：予約から当日までとても丁寧な対応でした。',
    listing: { kind: 'free' as const },
  };
}

describe('参考になった・通報', () => {
  it('自分の口コミには押せず、他人の押下で件数が増減する', async () => {
    await createVerifiedUser(ctx.db, { email: 'helpful-author@example.com', nickname: 'helpfulauthor', password: 'password-123' });
    const author = new Client(ctx.app); await author.loginAs('helpful-author@example.com', 'password-123');
    await author.post('/api/reviews', { ...freeBodyFor('h'), therapistSlug: 'sora', body: '独自の内容その3：予約時の対応が丁寧でした。' });

    await createVerifiedUser(ctx.db, { email: 'modh@example.com', nickname: 'modh', password: 'password-123', role: 'moderator' });
    const mod = new Client(ctx.app); await mod.loginAs('modh@example.com', 'password-123');
    const target = (await mod.get('/api/admin/queue')).json().items.find((q: { authorNickname: string }) => q.authorNickname === 'helpfulauthor');
    await mod.post(`/api/admin/reviews/${target.id}/moderate`, { decision: 'approve', usageVerified: true });

    const own = await author.post(`/api/reviews/${target.id}/helpful`, {});
    expect(own.statusCode).toBe(400);

    await createVerifiedUser(ctx.db, { email: 'voter@example.com', nickname: 'voter', password: 'password-123' });
    const voter = new Client(ctx.app); await voter.loginAs('voter@example.com', 'password-123');
    const on = await voter.post(`/api/reviews/${target.id}/helpful`, {});
    expect(on.json()).toEqual({ helpful: true, count: 1 });
    const off = await voter.post(`/api/reviews/${target.id}/helpful`, {});
    expect(off.json()).toEqual({ helpful: false, count: 0 });

    const report = await voter.post(`/api/reviews/${target.id}/report`, { reason: 'テスト通報' });
    expect(report.json()).toEqual({ ok: true });
  });
});
