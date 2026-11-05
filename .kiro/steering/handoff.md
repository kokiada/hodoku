# Hodoku 引き継ぎ（まず最初に読む）

最終更新: 2026-11-05

このファイルは、このプロジェクトを引き継ぐAI/開発者が**最初に読む**ための要約です。詳細は各参照先に分けてあります。常に読み込まれる steering なので、ここは「地図」に徹し、重い詳細は参照にとどめます。

## 0. 関連ドキュメントの地図
- `.kiro/steering/engineering.md` — コーディング規約・品質ゲート・**壊してはいけないセキュリティ不変条件**。実装前に必読。
- `.kiro/steering/team.md` — このプロジェクトを運用する「エージェント組織（チーム）」の定義と使い方。
- `.kiro/steering/release-checklist.md` — 公開(フェーズ1/2)の到達状況と、**AIでは完了できない🔒項目**。
- `HANDOFF.md`（リポジトリ直下） — 実装の詳細な技術引き継ぎ（データモデル・API一覧・ハマりどころ）。このsteeringと重複する箇所はあるが、最も詳しいのは HANDOFF.md。
- `docs/ORG.md` — 組織図とRACI。`docs/DEPLOY.md` — 低コストデプロイ手順。
- `README.md` — 手元での動かし方とデモの見どころ。

## 1. これは何か
女性向けの性風俗関連サービス（いわゆる女性用風俗）の**店舗・担当者の口コミ・比較サイト**。運営は掲載店から報酬を受け取らない中立の立場。口コミは1件ずつ有料で販売でき、**販売価格の90%が投稿者・10%が運営手数料**。18歳未満は利用不可。

**プロダクトの軸（オーナーの意向）**:
- 「人（担当者）から探す」が主導線。女性は店より人を見る。「沼っている人が、その人についた他の人の口コミを気にする」に訴求（`public/people.html` と `GET /api/therapists`、トップのCTA）。
- 「口コミを書く人はお金儲けができる」を売りにする。投稿者への90%還元は実装済み（下記フェーズ参照）。
- 決済は**ビットキャッシュのみ**＋独自ポイント「風マネーポイント」。チャージ型（最低決済額の都合で1件都度決済は不可のため）。サブスク（月額会員）は**廃止済み**、単品購入のみ。

## 2. 技術スタック / 動かし方
- Node 22 + TypeScript(ESM, import は `.js` 拡張子) + Fastify 5。DB は本番 PostgreSQL / 開発・テスト PGlite（同じSQLが両方で動く）。SPAフレームワークなし、`public/` の静的HTML + `assets/hodoku.js`。
- 開発: `npm install && npm run dev` → http://localhost:3000（**localhost で開く。127.0.0.1 はOrigin不一致でCSRFが弾く**）。初回にデモデータ・デモアカウント投入（全員パスワード `demo-password-1`、`README.md`）。
- 品質ゲート: `npm run typecheck` / `npm test`(Vitest, 115件) / `npm run smoke`(23項目) / `npm run preflight`(本番設定ガード) / `npm run build:prod`。
- 確認/再設定メールは開発では送信されずログに出る。決済はstubで疑似。

## 3. コード地図（`src/`）
- `index.ts` 合成ルート（migrate→seed→listen、各サービス/プロバイダをここで生成し `buildApp` に渡す） / `app.ts` Fastify組み立て（CSP・CSRF・Origin・ルート登録・DI） / `config.ts` 環境変数(zod)。
- `auth/`（登録・ログイン・ロック・再設定・TOTP・年齢ゲート・セッション） / `catalog/`（店舗・担当者一覧） / `reviews/`（投稿・審査・担当者ページ） / `commerce/`（円購入・返金・残高元帳・出金・**銀行振込先**・通報） / `points/`（風マネーポイントのチャージ・消費・口コミ解放） / `payments/provider.ts`（決済差し替え口） / `domain/`（価格計算・類似度・ポイントパック・信頼度の純粋関数） / `lib/`（crypto・csrf・totp・mailer・rate-key）。
- マイグレーション `src/db/migrations/001〜007`（007=銀行口座）。`tsc` は `.sql` を出力しないので `build:prod` が `scripts/copy-assets.mjs` で dist へコピーする（忘れると本番起動が ENOENT で落ちる）。

## 4. お金の流れ（最重要・壊さない）
- 有料口コミの閲覧は2経路が併存: ①旧「円で直接購入」(`purchases`) ②現行「ポイントで解放」(`review_unlocks`)。本番の既定は①無効・②は決済未接続で停止。
- どちらの経路でも**投稿者へ販売価格の90%を「円」で還元**し、`ledger_entries` の `kind='sale'` に記録。残高＝`sum(amount_yen)`。出金もこの残高から。
- **二重計上防止**: `ledger_entries (ref_id, kind)` 一意制約が最終防衛線。①は `ref_id=purchase_id`、②は `ref_id=review_unlocks.id`。②では「同じ読者が①で購入済みなら解放しても再計上しない」クロスチェックあり。
- 出金: 振込先銀行口座を登録(`bank_accounts`、口座番号は AES-256-GCM 暗号化・表示は下4桁)→残高を出金申請→管理者が口座を開示(監査ログ)して**手動で銀行振込**→支払済みに。**自動送金・KYC・税務は未実装、出金は本番既定オフ**。
- 金額は常にサーバーが決定。クライアントの金額は信用しない。

## 5. 公開フェーズ（`release-checklist.md` が正）
- **フェーズ1（無料公開）**: 比較・口コミの閲覧/投稿。有料販売・ポイントチャージ・出金はオフ。技術側はほぼ完了。残りは🔒（法務文面の確定・運営者情報・年齢確認方式・ドメイン/SSL）。
- **フェーズ2（有料化）**: ポイントチャージ(ビットキャッシュ)・有料販売・出金を有効化。🔒（決済代行の審査接続・KYC・税務・特商法表記）。
- `GET /api/config` の `salesEnabled`/`pointsEnabled` で画面の有料導線を出し分け。無効時は「後日公開」表示。決済を接続すると自動で導線復活（コード変更不要）。

## 6. 絶対に守る（詳細は engineering.md）
- パスワードscrypt、セッション/メールトークンはハッシュ保存。CSRF(double-submit)+Origin検証。年齢ゲートは署名Cookie。
- 有料本文は権限確認後のみ全文返却（未購入は冒頭50字）。ユーザー投稿は `textContent`/`window.h()` で描画（`innerHTML` 禁止・XSS対策）。
- CSP: **script のみ per-request nonce、style は 'unsafe-inline' 維持**（helmet の enableCSPNonces は style にも nonce を付けてインラインstyleを全無効化＝レイアウト崩壊するので使わない。自前でCSPヘッダ付与。`src/app.ts`）。
- 変更後は typecheck と test を緑に。money/auth に触るときは `semantic_reviewer` でレビュー。

## 7. 「AIでは完了できない」こと（正直な線引き）
決済代行の審査・接続、実際の銀行送金、本人確認(KYC)、税務（源泉・インボイス）、法務文面の法的確定、運営者の実在情報、実ドメイン取得。これらは専門家・審査・オーナー承認が必須。AIはドラフト・実装準備・差し替え口の用意までしかできない。引き継ぐAIもこの線引きを守り、誇大な実装や「完了」の偽装をしないこと。

## 8. リポジトリ / デプロイ
- git remote: `git@github.com:kokiada/hodoku.git`。このマシンは `~/.ssh/config` の `github-kokiada` ホストエイリアス（kokiada鍵）で push する（既定鍵は別アカウント KGoto6 なので要注意）。
- CI: `.github/workflows/ci.yml`（typecheck→test→build→preflight→smoke＋Dockerビルド）。
- デプロイは `docs/DEPLOY.md`（Docker Compose + PostgreSQL + Caddy 自動HTTPS、低コストVPS1台想定）。`docker compose up -d --build`。本番は `NODE_ENV=production`・`DATABASE_URL`・32文字以上の `SESSION_SECRET`・https の `BASE_URL`・SMTP が必須（未設定は起動時に例外）。
