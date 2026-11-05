// 実際のエントリポイント(src/index.ts)を子プロセスで起動し、主要ページ・APIが応答するかを確認して終了する
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3290;

// 前回の取り残しサーバーに誤って接続しないよう、ポートが空いていることを先に確認する
const inUse = await fetch(`http://127.0.0.1:${PORT}/healthz`).then(() => true, () => false);
if (inUse) { console.log(`ERROR  ポート${PORT}が使用中です。前回のサーバーが残っている可能性があります（ps で src/index.ts を確認）`); process.exit(1); }

const dataDir = mkdtempSync(join(tmpdir(), 'hodoku-smoke-'));
// npx を挟むとSIGTERMが孫プロセスに届かず取り残されるため、node + tsx を直接起動し、プロセスグループごと止める
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), PGLITE_DIR: join(dataDir, 'pg'), BASE_URL: `http://127.0.0.1:${PORT}`, NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
const stop = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* すでに終了 */ } };
process.on('exit', stop);
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: string[] = [];
const ok = (name: string, cond: boolean) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}`);

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return true; } catch { /* まだ起動中 */ }
    await sleep(500);
  }
  return false;
}

let cookies = '';
async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...init, headers: { cookie: cookies, ...(init.headers ?? {}) } });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';'); const [k] = kv!.split('=');
    cookies = cookies.split('; ').filter((x) => x && !x.startsWith(k + '=')).concat(kv!).join('; ');
  }
  return res;
}
const csrf = () => /hodoku_csrf=([^;]+)/.exec(cookies)?.[1] ?? '';
const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() }, body: JSON.stringify(body) });

try {
  const up = await waitUp();
  ok('サーバーが起動して /healthz に応答する', up);
  if (!up) throw new Error('起動できませんでした\n' + log);

  ok('デモアカウントの案内がログに出る', log.includes('admin@example.com') && log.includes('demo-password-1'));
  ok('年齢確認前はページが /age に飛ぶ', (await call('/')).status === 302);
  await post('/api/auth/age-confirm', {});
  for (const p of ['/', '/shops', '/shop?slug=atelier-lumen', '/therapist?slug=kai', '/review?slug=kai', '/guide', '/membership', '/compare', '/legal', '/login', '/account', '/admin']) {
    const r = await call(p);
    ok(`${p} が表示される (${r.status})`, r.status === 200);
  }
  const shops = await (await call('/api/shops')).json() as { shops: unknown[] };
  ok(`店舗一覧APIが${shops.shops.length}件返す`, shops.shops.length === 4);

  const therapist = await (await call('/api/therapists/kai')).json() as { reviews: Array<{ kind: string; locked: boolean; body: string }>; summary: { count: number } };
  const paid = therapist.reviews.filter((r) => r.kind === 'paid');
  ok(`担当者ページに口コミ${therapist.summary.count}件、うち有料${paid.length}件`, therapist.summary.count >= 4 && paid.length === 2);
  ok('未ログインの有料口コミはロック表示(冒頭50字)', paid.every((r) => r.locked && Array.from(r.body).length <= 50));

  const login = await post('/api/auth/login', { email: 'reader@example.com', password: 'demo-password-1' });
  ok('デモアカウントでログインできる', login.status === 200);
  const buy = await (await call('/api/therapists/kai')).json() as { reviews: Array<{ id: string; kind: string; locked: boolean }> };
  const target = buy.reviews.find((r) => r.kind === 'paid' && r.locked)!;
  const purchase = await post(`/api/reviews/${target.id}/purchase`, {});
  ok('デモ決済(stub)で購入できる', purchase.status === 201);
  const after = await (await call('/api/therapists/kai')).json() as { reviews: Array<{ id: string; locked: boolean }> };
  ok('購入後は全文が解放される', after.reviews.find((r) => r.id === target.id)?.locked === false);

  const adminLogin = await post('/api/auth/login', { email: 'admin@example.com', password: 'demo-password-1' });
  ok('管理者でログインできる', adminLogin.status === 200);
  const queue = await (await call('/api/admin/queue')).json() as { items: unknown[] };
  ok(`審査キューに${queue.items.length}件ある`, queue.items.length === 1);
} catch (e) {
  results.push('ERROR  ' + (e as Error).message);
} finally {
  stop();
  await sleep(800);
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(results.join('\n'));
process.exit(results.some((r) => /^(FAIL|ERROR)/.test(r)) ? 1 : 0);
