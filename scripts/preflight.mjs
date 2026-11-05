// フェーズ1公開のプリフライト点検。本番相当の環境変数で loadConfig を通し、
// 「公開前に落ちているべき設定」が正しく落ちている／正しく通ることを確認する。
// 使い方: node --import tsx scripts/preflight.mjs   （tsx 経由で TS を読む）
import { loadConfig } from '../src/config.js';

let failed = 0;
const ok = (label) => console.log(`  OK   ${label}`);
const bad = (label, extra = '') => { failed++; console.log(`  FAIL ${label} ${extra}`); };

function expectThrow(label, env) {
  try { loadConfig(env); bad(label, '（例外が出るべきなのに通った）'); }
  catch { ok(label); }
}
function expectPass(label, env, check) {
  try { const c = loadConfig(env); if (check && !check(c)) return bad(label, '（値が期待と違う）'); ok(label); }
  catch (e) { bad(label, `（通るべきなのに失敗: ${e.message}）`); }
}

// フェーズ1の本番標準セット（有料・出金・ポイントはすべてオフ）
const base = {
  NODE_ENV: 'production',
  BASE_URL: 'https://example.com',
  DATABASE_URL: 'postgres://u:p@db:5432/hodoku',
  SESSION_SECRET: 'x'.repeat(40),
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'Hodoku <no-reply@example.com>',
};

console.log('== 本番で危険な設定は起動時に落ちる ==');
expectThrow('SESSION_SECRET が短いと落ちる', { ...base, SESSION_SECRET: 'short' });
expectThrow('DATABASE_URL 未設定だと落ちる', { ...base, DATABASE_URL: undefined });
expectThrow('BASE_URL が https でないと落ちる', { ...base, BASE_URL: 'http://example.com' });
expectThrow('SMTP 未設定だと落ちる', { ...base, SMTP_HOST: undefined, MAIL_FROM: undefined });
expectThrow('PAYMENT_PROVIDER=stub は本番で落ちる', { ...base, PAYMENT_PROVIDER: 'stub' });
expectThrow('POINTS_PROVIDER=stub は本番で落ちる', { ...base, POINTS_PROVIDER: 'stub' });
expectThrow('POINTS_PROVIDER=bitcash で署名シークレット未設定だと落ちる', { ...base, POINTS_PROVIDER: 'bitcash' });

console.log('== フェーズ1の既定が安全（有料・出金・ポイントがオフ） ==');
expectPass('標準セットは起動でき、有料/出金/ポイントがすべてオフ', base, (c) =>
  c.paymentProvider === 'disabled' && c.payoutsEnabled === false && c.pointsProvider === 'disabled');

console.log('== フェーズ2（有料化）に切り替えると bitcash + シークレットが要る ==');
expectPass('POINTS_PROVIDER=bitcash + シークレットは起動できる', { ...base, POINTS_PROVIDER: 'bitcash', BITCASH_WEBHOOK_SECRET: 's'.repeat(32) }, (c) => c.pointsProvider === 'bitcash');

console.log('');
if (failed) { console.error(`プリフライト失敗: ${failed} 件`); process.exit(1); }
console.log('プリフライト: すべて OK（フェーズ1公開の設定ガードは健全）');
