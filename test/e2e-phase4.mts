// 画面接続の一気通貫E2E：投稿→審査→購入→本文公開→返金→出金→管理画面
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPgliteDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedCatalog } from '../src/db/seed.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { StubPaymentProvider, StubPointsProvider } from '../src/payments/provider.js';
import { hashPassword } from '../src/lib/crypto.js';

const require = createRequire(import.meta.url);
const pw = require('/home/koki/.nvm/versions/node/v22.14.0/lib/node_modules/@playwright/cli/node_modules/playwright');

const PORT = 3218;
const config = loadConfig({
  NODE_ENV: 'test', BASE_URL: `http://127.0.0.1:${PORT}`, AUTH_RATE_LIMIT_MAX: '1000', PAYOUTS_ENABLED: 'true', MIN_PAYOUT_YEN: '100',
} as NodeJS.ProcessEnv);
const db = await createPgliteDb(); await migrate(db); await seedCatalog(db);
const mailer = new MemoryMailer();
const payments = new StubPaymentProvider();
const app = await buildApp({ config, db, mailer, publicDir: join(process.cwd(), 'public'), payments, pointsProvider: new StubPointsProvider() });
await app.listen({ port: PORT, host: '127.0.0.1' });

// モデレーター・管理者はサインアップ経路が無いので、直接DBに作る
const mkStaff = async (email: string, nickname: string, role: 'moderator' | 'admin') => {
  await db.query('INSERT INTO users (id,email,nickname,password_hash,role,email_verified_at) VALUES ($1,$2,$3,$4,$5,now())',
    [randomUUID(), email, nickname, await hashPassword('password-123'), role]);
};
await mkStaff('mod@example.com', 'modstaff', 'moderator');
await mkStaff('admin@example.com', 'adminstaff', 'admin');

const results: string[] = [];
const ok = (name: string, cond: boolean) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
const base = `http://127.0.0.1:${PORT}`;
const browser = await pw.chromium.launch({ channel: 'chrome' });

async function signup(ctx: unknown, email: string, nickname: string) {
  const page = await (ctx as { newPage(): Promise<any> }).newPage();
  await page.goto(base + '/age');
  await page.click('#yes');
  await page.waitForURL(base + '/');
  await page.goto(base + '/membership#signup');
  await page.fill('#em', email); await page.fill('#nn', nickname); await page.fill('#pw', 'password-123');
  await page.click('#go');
  await page.waitForTimeout(800);
  const link = /(http:\/\/[^\s]+\/verify\?token=[\w-]+)/.exec(mailer.outbox.at(-1)!.text)![1];
  await page.goto(link); await page.waitForTimeout(400);
  await page.goto(base + '/login');
  await page.fill('#em', email); await page.fill('#pw', 'password-123'); await page.click('#go');
  await page.waitForURL('**/account');
  return page;
}

try {
  const authorCtx = await browser.newContext();
  const author = await signup(authorCtx, 'writer@example.com', 'writer01');

  await author.goto(base + '/therapist?slug=kai');
  await author.click('#write');
  await author.waitForURL('**/review.html?slug=kai');
  ok('口コミを書くボタンで review.html?slug=kai に遷移する', author.url().includes('slug=kai'));
  await (await author.waitForSelector('#target')).waitForElementState('stable');
  ok('投稿フォームに担当者名が表示される', (await author.textContent('#target'))?.includes('Kai') ?? false);

  await author.locator('[name="when"][value="this_month"]').check({ force: true });
  await author.locator('[name="len"][value="90"]').check({ force: true });
  await author.locator('[name="ng"][value="on_booking"]').check({ force: true });
  await author.locator('[name="total"][value="matched"]').check({ force: true });
  await author.locator('[name="s1"][value="5"]').check({ force: true }); await author.locator('[name="s2"][value="5"]').check({ force: true }); await author.locator('[name="s3"][value="5"]').check({ force: true });
  await author.locator('[name="gift"][value="no"]').check({ force: true });
  const longBody = 'とても丁寧な対応で、予約から当日までの流れもわかりやすく説明してもらいました。緊張していたのを察して、ゆっくり進めてもらえたので安心できました。総額も事前の案内どおりで、落ち着いて過ごせました。終わったあとの連絡もていねいで、また利用したいと感じました。';
  await author.fill('#memo', longBody);
  await author.locator('[name="pub"][value="paid"]').check({ force: true });
  await author.locator('[name="price"][value="300"]').check({ force: true });
  await author.locator('[name="agree"]').check({ force: true });
  await author.click('button[type=submit]');
  await author.waitForTimeout(600);
  ok('投稿後に完了画面が表示される', (await author.textContent('body'))?.includes('審査に送りました') ?? false);

  const modCtx = await browser.newContext();
  const mod = await modCtx.newPage();
  await mod.goto(base + '/age'); await mod.click('#yes'); await mod.waitForURL(base + '/');
  await mod.goto(base + '/login'); await mod.fill('#em', 'mod@example.com'); await mod.fill('#pw', 'password-123'); await mod.click('#go');
  await mod.waitForURL('**/account');
  await mod.goto(base + '/admin');
  await mod.waitForSelector('#tbody tr');
  const rowText = await mod.textContent('#tbody');
  ok('審査キューに投稿が表示される', !!rowText?.includes('writer01'));
  await mod.click('#tbody tr');
  await mod.click('#q-verified');
  await mod.click('text=承認して有料で公開');
  await mod.waitForTimeout(500);
  ok('承認すると件数が減る', !(await mod.textContent('#tbody'))?.includes('writer01'));

  const buyerCtx = await browser.newContext();
  const buyer = await signup(buyerCtx, 'buyer@example.com', 'buyer01');
  await buyer.goto(base + '/therapist?slug=kai');
  await buyer.waitForSelector('.lock-ui button');
  await buyer.click('.lock-ui button');
  await buyer.waitForSelector('#buyDlg[open]');
  ok('購入ダイアログに投稿者取り分が表示される', (await buyer.textContent('#buy-author'))?.includes('270') ?? false);
  await buyer.click('#buyGo');
  await buyer.waitForTimeout(900);
  const afterBuy = await buyer.textContent('body');
  ok('購入後に全文が表示される', !!afterBuy?.includes('また利用したいと感じました'));

  await buyer.goto(base + '/account');
  await buyer.click('#t-bought');
  await buyer.waitForTimeout(300);
  const boughtText = await buyer.textContent('#p-bought');
  ok('マイページの購入済みタブに表示される', !!boughtText?.includes('writer01'));
  buyer.once('dialog', (d: { accept(t?: string): Promise<void> }) => d.accept('内容が期待と違ったため'));
  await buyer.click('text=返金を申請');
  await buyer.waitForTimeout(800);

  await mod.goto(base + '/admin');
  await mod.click('[data-view="refunds"]');
  await mod.waitForTimeout(400);
  ok('返金申請が管理画面に表示される', !!(await mod.textContent('#tbody'))?.includes('buyer01'));
  await mod.click('#tbody tr');
  await mod.click('text=承認して返金する');
  await mod.waitForTimeout(500);

  await author.goto(base + '/account');
  await author.waitForTimeout(300);
  const balanceText = await author.textContent('#s-balance');
  ok('著者の残高が反映される（返金後は0円）', balanceText === '¥0');

  await mod.goto(base + '/admin');
  ok('モデレーターには出金メニューが出ない', !(await mod.textContent('.side'))?.includes('出金申請'));

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto(base + '/age'); await admin.click('#yes'); await admin.waitForURL(base + '/');
  await admin.goto(base + '/login'); await admin.fill('#em', 'admin@example.com'); await admin.fill('#pw', 'password-123'); await admin.click('#go');
  await admin.waitForURL('**/account');
  await admin.goto(base + '/admin');
  ok('管理者には出金メニューが出る', !!(await admin.textContent('.side'))?.includes('出金申請'));

  const strangerCtx = await browser.newContext();
  const stranger = await strangerCtx.newPage();
  await stranger.goto(base + '/age'); await stranger.click('#yes'); await stranger.waitForURL(base + '/');
  await stranger.goto(base + '/admin');
  await stranger.waitForTimeout(500);
  ok('権限のない人には管理メニューが描画されない', !(await stranger.evaluate(() => document.body.innerText)).includes('投稿審査'));
  ok('一般ユーザーは管理画面を閲覧できない', !!(await stranger.textContent('body'))?.includes('権限がありません'));

  await authorCtx.close(); await modCtx.close(); await buyerCtx.close(); await adminCtx.close(); await strangerCtx.close();
} finally {
  await browser.close(); await app.close(); await db.close();
}
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
