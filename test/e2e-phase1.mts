// 実ブラウザで 年齢確認→登録→メール確認→ログイン→ログアウト を通す（自己完結。終了時にサーバーも停止）
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPgliteDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { StubPaymentProvider, StubPointsProvider } from '../src/payments/provider.js';

const require = createRequire(import.meta.url);
const pw = require('/home/koki/.nvm/versions/node/v22.14.0/lib/node_modules/@playwright/cli/node_modules/playwright');

const PORT = 3217;
const config = loadConfig({ NODE_ENV: 'test', BASE_URL: `http://127.0.0.1:${PORT}`, AUTH_RATE_LIMIT_MAX: '1000' } as NodeJS.ProcessEnv);
const db = await createPgliteDb(); await migrate(db);
const mailer = new MemoryMailer();
const app = await buildApp({ config, db, mailer, publicDir: join(process.cwd(), 'public'), payments: new StubPaymentProvider(), pointsProvider: new StubPointsProvider() });
await app.listen({ port: PORT, host: '127.0.0.1' });

const results: string[] = [];
const ok = (name: string, cond: boolean) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
const browser = await pw.chromium.launch({ channel: 'chrome' });
try {
  const page = await (await browser.newContext()).newPage();
  const errs: string[] = [];
  page.on('pageerror', (e: Error) => errs.push(e.message));
  page.on('console', (m: { type(): string; text(): string }) => m.type() === 'error' && !m.text().includes('401') && errs.push(m.text()));
  // ページ遷移中にブラウザが先読みリソース(favicon等)の取得を打ち切るのは正常。失敗として数えない
  page.on('requestfailed', (r: { url(): string; failure(): { errorText: string } | null }) => {
    if (r.failure()?.errorText === 'net::ERR_ABORTED' && /favicon/.test(r.url())) return;
    errs.push('FAILED ' + r.url() + ' ' + r.failure()?.errorText);
  });
  const base = `http://127.0.0.1:${PORT}`;

  await page.goto(base + '/shops');
  ok('未確認で /shops を開くと年齢確認へ飛ぶ', page.url().includes('/age?next=%2Fshops'));
  await page.click('#yes');
  await page.waitForURL('**/shops');
  ok('「はい」で元のページ(/shops)に戻る', page.url().endsWith('/shops'));

  await page.goto(base + '/membership#signup');
  await page.fill('#em', 'e2e@example.com');
  await page.fill('#nn', 'e2euser');
  await page.fill('#pw', 'e2e-password-1');
  await page.click('#go');
  await page.waitForTimeout(1200);
  const body = await page.textContent('body');
  ok('登録フォーム送信後に「確認メールを送りました」が出る', !!body?.includes('確認メールを送りました'));
  ok('確認メールが送信された', mailer.outbox.length === 1);

  const link = /(http:\/\/[^\s]+\/verify\?token=[\w-]+)/.exec(mailer.outbox[0]!.text)?.[1] ?? '';
  await page.goto(link);
  await page.waitForTimeout(800);
  ok('確認リンクで登録が完了する', !!(await page.textContent('#state'))?.includes('登録が完了'));

  await page.goto(base + '/login');
  await page.fill('#em', 'e2e@example.com');
  await page.fill('#pw', 'wrong-password');
  await page.click('#go');
  await page.waitForTimeout(500);
  ok('誤ったパスワードでエラーメッセージが出る', !!(await page.textContent('#msg'))?.includes('違います'));
  await page.fill('#pw', 'e2e-password-1');
  await page.click('#go');
  await page.waitForURL('**/account');
  ok('ログイン後にマイページへ遷移する', page.url().endsWith('/account'));
  const nav = await page.textContent('.site-header nav');
  ok('ナビが「ログアウト」に変わる', !!nav?.includes('ログアウト'));

  await page.click('text=ログアウト');
  await page.waitForURL(base + '/');
  await page.goto(base + '/api/auth/me');
  ok('ログアウト後は /me が null', (await page.textContent('body'))?.includes('"user":null') ?? false);
  ok('コンソールエラー・ページエラーなし', errs.length === 0);
  if (errs.length) results.push('  ' + errs.join('\n  '));
} finally {
  await browser.close(); await app.close(); await db.close();
}
console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
