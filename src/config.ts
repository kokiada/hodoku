import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** 公開URL。Origin検証・メール内リンクに使う */
  BASE_URL: z.string().url().default('http://localhost:3000'),
  /** 未設定なら開発用の組み込みPostgreSQL(PGlite)を使う */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('./data/pglite'),
  /** 署名・ハッシュ用。本番は32文字以上必須 */
  SESSION_SECRET: z.string().optional(),
  /** リバースプロキシ配下なら true（X-Forwarded-* を信頼） */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  /** 認証系API（登録・ログイン等）の15分あたり上限回数（IPごと） */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  /** SMTPサーバのホスト。未設定なら送信せずMemoryMailerのまま（本番は警告） */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true=465のTLS直結、false=STARTTLS(587) */
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** メールの差出人。SMTP利用時は必須 */
  MAIL_FROM: z.string().optional(),
  /** 決済プロバイダ。stub=テスト用（本番不可）、disabled=購入を受け付けない */
  PAYMENT_PROVIDER: z.enum(['stub', 'disabled']).optional(),
  /** ポイントのチャージ決済。stub=テスト用（本番不可）、bitcash=本番、disabled=受け付けない */
  POINTS_PROVIDER: z.enum(['stub', 'bitcash', 'disabled']).optional(),
  /** ビットキャッシュ Webフックの署名検証用シークレット（POINTS_PROVIDER=bitcash で必須） */
  BITCASH_WEBHOOK_SECRET: z.string().optional(),
  /** 出金の受付。振込先登録・本人確認が整うまで本番では既定で無効 */
  PAYOUTS_ENABLED: z.enum(['true', 'false']).optional(),
  /** 手数料率（%）。販売価格に対する運営の取り分 */
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(10),
  /** 最低出金額（円） */
  MIN_PAYOUT_YEN: z.coerce.number().int().min(0).default(1000),
  /** 返金を申請できる期間（時間） */
  REFUND_WINDOW_HOURS: z.coerce.number().int().min(0).default(72),
});

export interface SmtpConfig { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }

export type Config = Omit<z.infer<typeof schema>, 'PAYMENT_PROVIDER' | 'PAYOUTS_ENABLED' | 'POINTS_PROVIDER' | 'BITCASH_WEBHOOK_SECRET' | 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASS' | 'MAIL_FROM'> & { sessionSecret: string; isProd: boolean; paymentProvider: 'stub' | 'disabled'; payoutsEnabled: boolean; smtp: SmtpConfig | null; pointsProvider: 'stub' | 'bitcash' | 'disabled'; bitcashWebhookSecret?: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const c = schema.parse(env);
  const isProd = c.NODE_ENV === 'production';
  let secret = c.SESSION_SECRET;
  if (isProd) {
    if (!secret || secret.length < 32) throw new Error('SESSION_SECRET は本番では32文字以上が必須です');
    if (!c.DATABASE_URL) throw new Error('DATABASE_URL は本番では必須です');
    if (!c.BASE_URL.startsWith('https://')) throw new Error('BASE_URL は本番では https:// が必須です');
  }
  secret ??= 'dev-only-secret-do-not-use-in-production-0000';
  // SMTP: ホストが指定されたら実送信。中途半端な設定（from欠落など）は誤送信防止のため起動時に弾く
  let smtp: SmtpConfig | null = null;
  if (c.SMTP_HOST) {
    if (!c.MAIL_FROM) throw new Error('SMTP_HOST を設定する場合は MAIL_FROM（差出人）も必須です');
    smtp = { host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE === 'true', user: c.SMTP_USER, pass: c.SMTP_PASS, from: c.MAIL_FROM };
  }
  // 本番で認証系の送信が必要な場合は SMTP 必須。未設定なら登録・再設定メールが飛ばないため起動時に弾く
  if (isProd && !smtp) throw new Error('本番では SMTP_HOST / MAIL_FROM の設定が必須です（メールが送信できません）');
  // 分割代入で SMTP_* を Config から除外しつつ残りを展開する
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM, POINTS_PROVIDER, BITCASH_WEBHOOK_SECRET, ...rest } = c;
  // 本番は実決済プロバイダが接続されるまで購入を受け付けない。テスト用stubでの課金ごっこを本番で動かさない
  const paymentProvider = rest.PAYMENT_PROVIDER ?? (isProd ? 'disabled' : 'stub');
  if (isProd && paymentProvider === 'stub') throw new Error('本番で PAYMENT_PROVIDER=stub は使えません');
  const payoutsEnabled = (rest.PAYOUTS_ENABLED ?? (isProd ? 'false' : 'true')) === 'true';
  // ポイントのチャージ決済（ビットキャッシュ）。本番で stub は不可。bitcash は Webフック署名シークレットが必須。
  const pointsProvider = POINTS_PROVIDER ?? (isProd ? 'disabled' : 'stub');
  if (isProd && pointsProvider === 'stub') throw new Error('本番で POINTS_PROVIDER=stub は使えません');
  if (pointsProvider === 'bitcash' && !BITCASH_WEBHOOK_SECRET) throw new Error('POINTS_PROVIDER=bitcash には BITCASH_WEBHOOK_SECRET が必須です');
  return { ...rest, sessionSecret: secret, isProd, paymentProvider, payoutsEnabled, smtp, pointsProvider, bitcashWebhookSecret: BITCASH_WEBHOOK_SECRET };
}
