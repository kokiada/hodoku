# デプロイ手順（低コスト・Docker 構成）

最終更新: 2026-11-05

小さな VPS 1台（例: 1 vCPU / 1〜2GB RAM）で、`app`（Node/Fastify）+ `db`（PostgreSQL）をコンテナで動かす最小構成。TLS 終端は前段のリバースプロキシ（Caddy など）で行う想定です。

> **公開前に必ず `/.kiro/steering/release-checklist.md` を確認してください。** 技術項目が緑でも、決済接続・法務文面・出金の本人確認/税対応（🔒 要人間）が未完なら本番公開はできません。

## 前提
- Docker と Docker Compose v2 が入った Linux ホスト。
- ドメインと DNS が VPS を向いていること。
- 送信可能な SMTP アカウント（メール送信は本番必須）。

## 手順

1. リポジトリを配置し、環境変数を用意する。
   ```bash
   cp .env.example .env
   # .env を編集:
   #  - SESSION_SECRET を 32文字以上のランダム値に（例: openssl rand -base64 48）
   #  - POSTGRES_PASSWORD を強いパスワードに
   #  - BASE_URL を本番ドメイン（https://...）に
   #  - SMTP_* と MAIL_FROM を実際の送信元に
   ```

2. 起動（ビルド込み）。
   ```bash
   docker compose up -d --build
   ```
   - 初回起動でマイグレーション（`001`〜`004`）が自動適用される。
   - 本番では `NODE_ENV=production` のためデモデータ・デモアカウントは投入されない。
   - app は既定で `127.0.0.1:3000`（`APP_BIND`）に bind。前段プロキシから接続する。

3. リバースプロキシ（例: Caddy）で TLS 終端し `127.0.0.1:3000` へ転送する。
   ```
   example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   Caddy が Let's Encrypt の証明書を自動取得・更新する（追加コストなし）。`TRUST_PROXY=true` のままにする。

4. 動作確認。
   ```bash
   curl -fsS https://example.com/healthz     # {"ok":true}
   docker compose logs -f app                 # 起動ログ・SMTP接続確認
   ```

## 最初の管理者アカウント

本番ではデモアカウントが作られないため、最初の管理者は手動で用意する。

1. 画面から通常登録 → 届いた確認メールのリンクで確認を完了する。
2. DB でそのユーザーを admin に昇格する。
   ```bash
   docker compose exec db psql -U hodoku -d hodoku \
     -c "UPDATE users SET role='admin' WHERE lower(email)=lower('you@example.com');"
   ```
3. ログイン後、管理者は 2段階認証（TOTP）を設定することを推奨:
   - `POST /api/auth/totp/setup` で `otpauth://` URI を取得し認証アプリに登録
   - `POST /api/auth/totp/confirm`（アプリのコード）で確定
   以後、その管理者のログインはパスワード＋コードの2段階になる。

## バックアップ・復元

DB は named volume `pgdata` に保存される。付属スクリプトで定期バックアップ・復元できる。

```bash
# 手動バックアップ（./backups に hodoku-<日時>.sql.gz を作成、既定14日より古いものは自動削除）
BACKUP_DIR=/var/backups/hodoku RETENTION_DAYS=14 ./scripts/backup-db.sh

# 復元（既存データに上書き。実行前に必ず現状のバックアップを取る）
./scripts/restore-db.sh /var/backups/hodoku/hodoku-20261105-033000.sql.gz
```

cron で毎日自動化する例:
```
30 3 * * * cd /path/to/hodoku-app && BACKUP_DIR=/var/backups/hodoku ./scripts/backup-db.sh >> /var/log/hodoku-backup.log 2>&1
```
`backup-db.sh` は gzip の整合性チェックを行い、壊れたファイルは破棄する。バックアップは別ホスト/オブジェクトストレージへ退避するとさらに安全（最小構成では同一VPS上）。

## 監視・ログ

- **ヘルスチェック**: アプリの `/healthz`（依存なしで応答）と Docker の HEALTHCHECK（イメージに内蔵）。
- **軽量な外形監視**: `scripts/healthcheck.sh` を cron で回し、失敗時に Slack 互換 Webhook へ通知できる（外部監視SaaSが無い場合向け）。
  ```
  */5 * * * * HEALTH_URL=https://example.com/healthz ALERT_WEBHOOK=https://hooks.slack.com/services/xxx /path/to/hodoku-app/scripts/healthcheck.sh >> /var/log/hodoku-health.log 2>&1
  ```
- **ログ**: アプリは pino の構造化ログ（Cookie/Authorization はマスク）。Docker のログは `json-file` ドライバで**1ファイル10MB×3世代にローテーション**設定済み（`docker-compose.yml`）。小さなVPSでディスクが埋まるのを防ぐ。
  ```bash
  docker compose logs -f app      # 追尾
  docker compose logs --since=1h  # 直近1時間
  ```

## 更新デプロイ

```bash
git pull
docker compose up -d --build   # 新イメージをビルドして入れ替え。マイグレーションは起動時に自動適用
```

## 既知の制約・未整備（継続課題）
- 監視は最小構成（`/healthz` + `scripts/healthcheck.sh` の cron 外形監視 + Docker ログのローテーション）。メトリクス収集・集中ログ基盤・ページング通知は未導入。
- 決済は `disabled`（購入は 503）。審査通過後に `src/payments/provider.ts` を実装して接続。
- 出金は `false`。本人確認・税対応が未実装。
- これらは `.kiro/steering/release-checklist.md` の 🔒 項目として管理。
