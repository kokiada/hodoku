# Hodoku アプリ 引き継ぎ資料

最終更新: 2026-11-05

女性向けの性風俗関連サービス（いわゆる女性用風俗）の店舗・担当者について、利用者の口コミと料金・規定の比較情報を提供するサイトのバックエンド＋画面実装。
運営は掲載店から報酬を受け取らない中立の立場。口コミは1件ずつ有料で販売でき、販売価格の90%が投稿者、10%が運営の手数料になる。

このリポジトリ（`hodoku-app/`）はデザインモック `../hodoku-assets/04_mock_html/` を土台に、DB・認証・課金・審査を実装したもの。デザインの基準・制約は `../hodoku-assets/HANDOFF.md` を参照。

> **運用体制・本番化メモ（2026-11-05 追記）**: 本アプリを運用する「エージェント組織」を `.kiro/agents/` に、運用ルールを `.kiro/steering/` に、組織図とデプロイ手順を `docs/` に定義した。本番化のうち技術的に完了した項目（SMTP・Docker・CI・管理者TOTP）は本資料のセクション9・12を参照。公開可否は `.kiro/steering/release-checklist.md` で管理する（決済接続・法務文面・税務は要専門家）。

---

## 1. 全体像

- 言語・実行環境: Node.js 22 + TypeScript（`type: module`、ESM）
- Webフレームワーク: Fastify 5
- DB: 本番は PostgreSQL（`pg`）。開発・テストは組み込みの PostgreSQL 互換 DB（PGlite）。**同じSQLが両方で動く**ので、開発にDB構築が不要。
- 画面: `public/` の静的HTML。サーバーが配信し、ブラウザ側のJSが `/api/*` を `fetch` で呼ぶ（SPAフレームワークは使っていない）。
- 認証: 自前実装（Cookieセッション）。外部IDaaSは不使用。
- テスト: Vitest（APIテスト）＋ Playwright（ブラウザE2E）＋ スモークテスト。

### 起動（開発）
```bash
npm install
npm run dev     # http://localhost:3000
```
初回起動でデモデータ（店舗4件・口コミ・アカウント4つ）が入る。詳細と見て回る順は `README.md`。

---

## 2. ディレクトリ構成

```
src/
  index.ts              エントリポイント（マイグレーション→シード→起動）
  app.ts                Fastify組み立て（CSP・CSRF・Origin検証・エラー整形・ルート登録）
  config.ts             環境変数の検証（zod）。本番で危険な設定を起動時に弾く
  static.ts             静的配信・クリーンURL・年齢ゲート・パストラバーサル対策
  db/
    index.ts            DB抽象（pg と PGlite の共通インターフェース、tx/exec）
    migrate.ts          番号順マイグレーション適用
    migrate-cli.ts      `npm run migrate` の実体
    migrations/*.sql    スキーマ（001_core / 002_catalog / 003_reviews）
    seed.ts             店舗・担当者の初期データ（開発時）
    seed-demo.ts        デモ用アカウント・口コミ（開発時のみ・既知パスワード）
  auth/
    service.ts          登録・メール確認・ログイン・ロックアウト・パスワード再設定
    session-cookie.ts   セッションCookieの読み書き
    age-gate.ts         年齢確認の署名付きCookie
    guard.ts            optionalUser / requireUser / requireStaff
  catalog/service.ts    店舗検索・比較・店舗詳細
  reviews/service.ts    口コミ投稿・担当者ページ・審査・参考になった・通報
  commerce/service.ts   購入・返金・残高（元帳）・出金・通報キュー
  payments/provider.ts  決済の差し替え口（Disabled / Stub）
  domain/
    rules.ts            価格計算・文面類似度・自動フラグ・有料出品可否（純粋関数）
    trust.ts            信頼度（high/mid/low）の算出
  lib/
    crypto.ts           scryptハッシュ・トークン・HMAC署名・定数時間比較
    totp.ts             管理者2段階認証（RFC 6238 TOTP, base32, otpauth URI）
    csrf.ts             double-submit cookie
    rate-key.ts         レート制限のキー（ログイン中はセッション、未ログインはIP）
    mailer.ts           メール送信（MemoryMailer / SmtpMailer=nodemailer）
public/                 画面（モック由来のHTML＋共通 assets/hodoku.js, hodoku.css）
test/                   後述
```

---

## 3. データモデル（主要テーブル）

マイグレーションは `src/db/migrations/`。要点のみ。

- **users** — メール・ニックネーム（どちらも小文字で一意、退会者除く）、`role`(user/moderator/admin)、`plan`、`email_verified_at`、ログイン失敗回数とロック、TOTP用(`totp_secret`/`totp_secret_pending`/`totp_enabled_at`/`totp_last_counter`)。
- **sessions** — セッションIDは生値を保存せず **SHA-256ハッシュのみ**。期限付き。
- **email_tokens** — メール確認・パスワード再設定。**ハッシュのみ**・1回限り・期限付き。
- **audit_log** — 管理操作・金銭操作の追記専用ログ。
- **shops / therapists** — 掲載情報。料金は `base_price_yen`＋`price_step_yen`（30分ごと）。安全対応・キャンセル規定は構造化JSON。`is_sample` で架空データ表示。
- **reviews** — 口コミ本体。評価・`gift_received`・`body`・`listing_kind`(free/paid)・`price_yen`・`usage_verified`・`status`(pending/published/rejected/changes_requested)・`auto_flags`・`similarity_score`。
- **review_helpful_votes / reports** — 参考になった（1人1票）・通報。
- **purchases** — 購入。`status`(pending/completed/failed/refunded)、`fee_yen`・`author_net_yen` を購入時に確定。`(review_id,buyer_id)` は pending/completed のとき一意（二重購入防止）。
- **refund_requests / payout_requests** — 返金・出金の申請キュー。open は1件のみ（部分一意インデックス）。
- **ledger_entries** — 投稿者残高の**追記専用元帳**。`sale`/`refund_clawback`/`payout`/`payout_reversal`。`(ref_id,kind)` 一意で二重計上を防止。残高は `sum(amount_yen)`。

---

## 4. API一覧

プレフィックス: `/api`（認証系は `/api/auth`、管理系は `/api/admin`）。
状態を変えるリクエストはCSRFトークン（Cookie `hodoku_csrf` とヘッダ `x-csrf-token` の一致）＋Origin検証が必要。ブラウザ側は `window.hodokuApi()` が自動付与。

### 認証 `/api/auth`
| メソッド | パス | 説明 |
|---|---|---|
| POST | `/age-confirm` | 年齢確認（署名Cookie発行） |
| POST | `/register` | 登録（確認メール送信） |
| POST | `/verify` | メール確認（トークン） |
| POST | `/login` / `/logout` | ログイン／ログアウト（TOTP有効時は login が `totpRequired` を返す） |
| POST | `/login/totp` | TOTPコードでログイン完了（チャレンジ＋コード） |
| GET | `/me` | 現在のユーザー（未ログインは null） |
| POST | `/request-reset` / `/reset-password` | パスワード再設定 |
| GET | `/totp/status` | TOTP有効状態（スタッフ） |
| POST | `/totp/setup` / `/totp/confirm` / `/totp/disable` | TOTPの設定・確定・無効化（スタッフ） |

### カタログ・口コミ `/api`
| メソッド | パス | 説明 |
|---|---|---|
| GET | `/shops` | 一覧（station, flags, budget, minutes, sort） |
| GET | `/shops/:slug` | 店舗詳細（minutes で総額再計算） |
| GET | `/therapists/:slug` | 担当者＋公開口コミ（**有料未購入は冒頭50字のみ**） |
| POST | `/reviews` | 投稿（要ログイン） |
| GET | `/me/reviews` | 自分の投稿（販売実績つき） |
| POST | `/reviews/:id/helpful` | 参考になった（トグル） |
| POST | `/reviews/:id/report` | 通報 |
| POST | `/reviews/:id/purchase` | 購入（金額はサーバーが決定） |
| GET | `/me/purchases` | 購入した口コミ |
| POST | `/purchases/:id/refund-request` | 返金申請 |
| GET | `/me/summary` | 残高・今月の売上・出金状況 |
| POST | `/me/payouts` | 出金申請（全額） |

### 管理 `/api/admin`（moderator 以上、出金のみ admin 限定）
| メソッド | パス | 説明 |
|---|---|---|
| GET | `/queue` / POST `/reviews/:id/moderate` | 投稿審査 |
| GET | `/refunds` / POST `/refunds/:id/decide` | 返金の承認・却下 |
| GET | `/payouts` / POST `/payouts/:id/decide` | 出金（**admin のみ**） |
| GET | `/reports` / POST `/reports/:id/close` | 通報対応 |

---

## 5. 重要な業務ルール（`src/domain/rules.ts`）

- **総額** = コース料金（60分基準＋30分ごと加算）＋指名料＋交通費。
- **分配** = 手数料率（既定10%、四捨五入）。`feeYen + authorNetYen` は必ず販売価格に一致。
- **有料出品の条件**（すべて必須）: 利用確認済み・店舗特典なし・本文120字以上・類似度70%未満・個人情報なし。
- **自動フラグ**: 類似文面（文字3-gramのJaccard 70%以上）・個人情報（電話/URL/メール）・誇大表現・特典。
- **18歳未満を連想させる表現**は投稿時点で拒否。
- **購入前プレビュー**は冒頭50字のみ。全文はサーバーが権限を確認してからしか返さない。

---

## 6. セキュリティ上の設計（レビュー時の要点）

- パスワードは scrypt。セッションID・メールトークンは**ハッシュで保存**。
- 年齢ゲートはサーバー側で署名Cookieを検証。未確認ならHTMLを返さず `/age` にリダイレクト。
- CSRF（double-submit）＋Origin検証。CSPは本番で `upgrade-insecure-requests` 有効。
- 静的配信は自前で、パストラバーサル・ドットファイルを拒否。`/admin` 等は `noindex`。
- 管理画面の権限チェックは**サーバー側API（`requireStaff`）が本体**。画面側の出し分けは表示のためだけ。
- 購入・返金・出金は金額をサーバーが決め、二重実行をDBの一意制約とトランザクションで防ぐ。決済失敗時は付与しない／自動返金する。

---

## 7. テスト

```bash
npm test            # APIテスト（Vitest, 92件）
npm run typecheck   # 型チェック
npm run smoke       # 実エントリポイントを起動し主要ページ・APIを確認（23項目）
npm run e2e:auth    # ブラウザ: 登録→メール確認→ログイン（要Chrome）
npm run e2e:flow    # ブラウザ: 投稿→審査→購入→返金→管理画面（要Chrome）
```

- `test/rules.test.ts` 業務ルールの純粋関数（15件）
- `test/auth.test.ts` 認証・CSRF・年齢ゲート・静的配信（19件）
- `test/totp.test.ts` 管理者TOTP（RFC6238ベクタ・登録・ログイン・ダウングレード/リプレイ防止、9件）
- `test/catalog.test.ts` 店舗検索・投稿・審査（15件）
- `test/commerce.test.ts` 購入・分配・返金・出金・決済無効・SMTP設定（ほか）
- `test/visibility.test.ts` **有料本文が未購入者に漏れないこと**（5件）
- `test/e2e-*.mts` ブラウザ通し（Chrome必須。CIでは要セットアップ）
- `test/smoke.mts` 本物の `src/index.ts` を子プロセス起動して確認

全テストは PGlite をメモリで使うため外部依存なしで走る。

---

## 8. 設定（環境変数）

`src/config.ts` が検証。本番で危険な値は**起動時に例外で停止**する。

| 変数 | 既定 | 備考 |
|---|---|---|
| NODE_ENV | development | production で各種チェックが厳格化 |
| PORT / HOST | 3000 / 127.0.0.1 | |
| BASE_URL | http://localhost:3000 | 本番は https 必須。Origin検証・メールリンクに使用 |
| DATABASE_URL | （未設定で PGlite） | 本番は必須 |
| PGLITE_DIR | ./data/pglite | 開発のみ |
| SESSION_SECRET | （開発用既定） | 本番は32文字以上必須 |
| TRUST_PROXY | false | リバースプロキシ配下なら true |
| AUTH_RATE_LIMIT_MAX | 10 | 認証系の15分あたり上限 |
| PAYMENT_PROVIDER | stub(開発)/disabled(本番) | 本番で stub は起動拒否 |
| PAYOUTS_ENABLED | true(開発)/false(本番) | 出金受付 |
| PLATFORM_FEE_PERCENT | 10 | 運営手数料 |
| MIN_PAYOUT_YEN | 1000 | 最低出金額 |
| REFUND_WINDOW_HOURS | 72 | 返金申請の受付期間 |

---

## 9. 本番化の状況（2026-11-05 更新）

### 技術的に完了したも
1. **SMTP メール送信** — `src/lib/mailer.ts` に `SmtpMailer`（nodemailer）を実装。`SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` で設定。本番は SMTP 必須（未設定なら起動時に例外）。STARTTLS(587) では `requireTLS` で平文送信を防止。
2. **管理者2段階認証（TOTP）** — `src/lib/totp.ts`（RFC 6238 を node:crypto のみで実装、外部依存なし）。moderator/admin が `/api/auth/totp/{setup,confirm,disable,status}` で設定。有効化後はログインがパスワード＋コードの2段階に（`/api/auth/login` が `totpRequired` とチャレンジを返し、`/api/auth/login/totp` で完了）。堅牢化: 新シークレットは `totp_secret_pending` に staging して確定まで現役を壊さない（再setupでの無効化を防止）、受理カウンタ(`totp_last_counter`)でコード使い回しを拒否、コード総当たりにも既存のアカウントロックアウトを適用。マイグレーション `004`/`005`。
3. **Docker / 本番構成** — マルチステージ `Dockerfile`（`dist/src`+`public` のみの軽量イメージ、非rootで実行、HEALTHCHECK付き）、`docker-compose.yml`（app + PostgreSQL16）、`.dockerignore`、本番ビルド専用 `tsconfig.build.json`（test を含めない）と `npm run build:prod`。
4. **CI** — `.github/workflows/ci.yml`（typecheck → test → build:prod → smoke、別ジョブで Docker イメージのビルド検証）。
5. **デプロイ手順 / env サンプル** — `docs/DEPLOY.md`（Caddy で TLS 終端する低コスト構成、初期管理者の作り方、バックアップ）、`.env.example`。
6. **有料は「後日公開」運用** — `GET /api/config` が `salesEnabled`（＝`paymentProvider !== 'disabled'`）を返す。本番既定は販売オフで、担当者ページの有料ロックUIは「後日公開予定」表示に、投稿フォームの有料オプションは非表示になる（`public/therapist.html`・`review.html`・`assets/hodoku.js` が `window.hodokuFlags` を参照）。決済を接続すると自動で有料導線が復活する（コード変更不要）。

### 🔒 公開前に必要な項目（2フェーズで管理。詳細と最新状況は `.kiro/steering/release-checklist.md`）

公開は2段階で考える（オーナー判断）:

- **フェーズ1（無料公開）**: 比較・口コミの閲覧/投稿を公開。**有料販売・出金はオフのまま**（本番既定 `PAYMENT_PROVIDER=disabled`・`PAYOUTS_ENABLED=false`、購入は503）。コード変更なしで出せる。
  - 要人間: プライバシーポリシー／利用規約・投稿ガイドライン／年齢確認方式／口コミ公開の法的リスク評価／運営主体表示／ドメイン・SSL・本番環境変数。**いずれも弁護士確認が前提。**
  - 注意: 「有料をオフにすれば法務不要」ではない。会員登録・口コミ公開の時点で上記は必須。
- **フェーズ2（有料化）**: 口コミ販売・出金を有効化。売上・支払いが発生して初めて必要になる項目。
  - 要人間: 決済プロバイダの審査・接続／出金のKYC・税区分（源泉・インボイス）／特商法表記の確定／利用確認(usage_verified)の運用。**税理士・弁護士の確認が必要。**

技術基盤（SMTP・TOTP・Docker・CI・監視/バックアップ・CSP）は両フェーズ共通で実装済み。

---

## 10. 次にやるとよい順

技術的な本番化（SMTP・Docker・CI・TOTP）は完了。残りは専門家・オーナー承認が必要な順。

1. 決済プロバイダ実装（審査完了後。差し替え口は `src/payments/provider.ts`）— payments-finance
2. 出金まわりの本人確認・税対応（専門家確認とセット）— payments-finance / legal-compliance
3. 法務文面の確定（弁護士確認）— legal-compliance
4. 監視・ログ・バックアップの本格運用 — sre-infra
5. 初期管理者の作成と TOTP 有効化（`docs/DEPLOY.md`）— sre-infra

---

## 11. 既知の注意点・ハマりどころ

- PGlite はパラメータ付きクエリで複数文を実行できない → マイグレーションは `exec()`（パラメータなし）を使う。
- PGlite はデフォルトでディレクトリを自動作成しない → `createPgliteDb` で `mkdir -p` 済み。
- PGlite はコールドスタート（wasm 初期化）で初回が遅い → `vitest.config.ts` で hook/test タイムアウトを 30秒に引き上げ済み（初回の `beforeAll` タイムアウト対策）。
- `date` / `timestamptz` はJSON化でズレることがある → 日付はSQL側で `to_char(... 'YYYY-MM-DD')` に整形して返す（店舗の最終確認日で対応済み）。
- CSSで `[hidden]` が `display:grid/flex` に負ける → `assets/hodoku.css` で `[hidden]{display:none!important}` を入れてある（管理画面の権限表示に影響する重要点）。
- ユーザー投稿は必ず `window.h()`／`textContent` 経由で描画（`innerHTML` を使わない、XSS対策）。
- スモークテストはサーバーを子プロセスで起動する。`npx` を挟むとSIGTERMが孫に届かず残るため、`node --import tsx` を detached 起動してプロセスグループごと停止している。
- ビルドは2種類: `npm run build`（dev・test込み）と `npm run build:prod`（`tsconfig.build.json`・`dist/src` のみ＋`scripts/copy-assets.mjs` で migrations/*.sql を dist へコピー。Docker と CI、`npm start` はこちら）。
- **マイグレーションSQLの同梱**: `tsc` は `.sql` を出力しない。`npm start`/Docker はコンパイル後の `dist/src/db/migrations` を参照するため、`build:prod` が `.sql` をコピーする。これを忘れると本番起動時に `ENOENT ... dist/src/db/migrations` でクラッシュする（実際に Docker 起動テストで検出・修正済み）。Dockerfile は build 段で `scripts/` もコピーする必要がある。
- 本番 Docker 起動テスト: `scripts/docker-boot-test.sh`（使い捨てPostgresと本番イメージを起動して `/healthz`・マイグレーション適用・TOTP列を確認し、終了時に後片付け）。Compose 不要。
- `docker compose` 検証: `scripts/compose-smoke.sh`（`docker compose up -d --build` → `/healthz`・`GET /`(302)・`GET /api/shops`(200) を確認して `down -v`）。要 `.env`（`.env.example` から作成）。
- Docker Compose v2 プラグインは `~/.docker/cli-plugins/docker-compose` にユーザーインストール済み（v5.7.0・checksum検証済み、sudo不要）。`docker compose version` で確認可。buildx 未導入のため Compose は classic builder にフォールバックするが動作に支障なし（CI は buildx を使用）。
- Docker の資格情報: `~/.docker/config.json` の `credsStore: desktop.exe`（Docker Desktop/Windows の残骸）があると公開イメージの pull が失敗する。Linux 環境では削除する。

---

## 12. 運用体制（エージェント組織）

本アプリを運用する会社組織を Kiro カスタムエージェントとして定義した。詳細は `docs/ORG.md`。

- `.kiro/agents/*.json` — 役割別エージェント: cto-architect / backend-engineer / sre-infra / security-engineer / qa-engineer / legal-compliance / payments-finance。各ロールは担当範囲・使えるツール・書き込み可能パスを絞ってある。
- `.kiro/steering/engineering.md` — 全ロール共通のエンジニアリング規約・品質ゲート・セキュリティ不変条件。
- `.kiro/steering/release-checklist.md` — 本番公開可否のチェックリスト（✅ 自動化可 / 🔒 要人間）。
- マネージャー（Kiro 本体）が依頼を分解して各ロールに委譲する。起動は `kiro-cli --agent <name>` またはセッション中に `/agent swap <name>`。
- `docs/DEPLOY.md` — デプロイ手順。
