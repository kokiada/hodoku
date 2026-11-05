import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seedCatalog } from './db/seed.js';
import { seedDemo, DEMO_ACCOUNTS, DEMO_PASSWORD } from './db/seed-demo.js';
import { MemoryMailer, SmtpMailer } from './lib/mailer.js';
import { buildApp } from './app.js';
import { DisabledPaymentProvider, StubPaymentProvider, DisabledPointsProvider, StubPointsProvider, BitcashPointsProvider, type PointsPaymentProvider } from './payments/provider.js';

const config = loadConfig();
const db = await createDb(config);
const applied = await migrate(db);
if (applied.length) console.log(`マイグレーション適用: ${applied.join(', ')}`);
if (!config.isProd) {
  await seedCatalog(db);
  // 既知のパスワードのアカウントを作るため、本番では絶対に動かさない
  if (await seedDemo(db)) {
    console.log('\n== デモアカウント（開発用・パスワードはすべて ' + DEMO_PASSWORD + '）==');
    for (const a of DEMO_ACCOUNTS) console.log(`  ${a.email.padEnd(20)} ${a.note}`);
    console.log('');
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, config.isProd ? '..' : '.', 'public');
// メール送信: SMTP が設定されていれば実送信、なければ MemoryMailer（開発はコンソール出力）
let mailer;
if (config.smtp) {
  const smtp = new SmtpMailer(config.smtp);
  try {
    await smtp.verify();
    console.log(`メール送信: SMTP ${config.smtp.host}:${config.smtp.port} に接続確認OK`);
  } catch (e) {
    console.warn(`警告: SMTP 接続確認に失敗しました（起動は継続）: ${(e as Error).message}`);
  }
  mailer = smtp;
} else {
  if (config.isProd) console.warn('警告: メール送信が未設定です（MemoryMailer）。本番運用前にSMTPを設定してください');
  mailer = new MemoryMailer(!config.isProd);
}

const payments = config.paymentProvider === 'stub' ? new StubPaymentProvider() : new DisabledPaymentProvider();
if (config.paymentProvider === 'disabled') console.warn('注意: 決済プロバイダ未接続のため、有料口コミの購入は受け付けません');

// ポイントのチャージ決済（ビットキャッシュ）プロバイダを選ぶ
let pointsProvider: PointsPaymentProvider;
if (config.pointsProvider === 'bitcash') pointsProvider = new BitcashPointsProvider(config.bitcashWebhookSecret!);
else if (config.pointsProvider === 'stub') pointsProvider = new StubPointsProvider();
else { pointsProvider = new DisabledPointsProvider(); if (config.isProd) console.warn('注意: ポイントのチャージ（ビットキャッシュ）は未接続のため受け付けません'); }

const app = await buildApp({ config, db, mailer, publicDir, payments, pointsProvider });
await app.listen({ port: config.PORT, host: config.HOST });

const shutdown = async () => { await app.close(); await db.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
