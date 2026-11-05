# Hodoku

予約の前に確かめて選ぶための比較・口コミサイト。

## 手元で動かす

Node 22 が必要です。DockerもPostgreSQLも不要です（開発中は組み込みのPostgreSQL互換DBを使います）。

```bash
npm install
npm run dev
```

ブラウザで http://localhost:3000 を開きます。最初に年齢確認が出ます。

初回起動時、店舗4件・口コミ・デモアカウントが自動で入ります。

| メール | パスワード | できること |
|---|---|---|
| admin@example.com | demo-password-1 | 管理画面（`/admin`）、出金の承認 |
| mod@example.com | demo-password-1 | 投稿審査・返金・通報（`/admin`） |
| writer@example.com | demo-password-1 | 一般ユーザー（口コミを書く） |
| reader@example.com | demo-password-1 | 一般ユーザー（有料口コミを買う） |

- 確認メール・パスワード再設定メールは**送信されず、ターミナルに出力**されます。リンクをコピーしてブラウザで開いてください。
- 決済は**テスト用の疑似決済**です。実際の課金は発生しません。
- データは `data/pglite/` に保存されます。最初からやり直すには、サーバーを止めて `data/` を削除してください。

## 見て回るおすすめ順

1. `/shops` 店舗を絞り込む → 「Atelier Lumen」の詳細（総額・安全対応・キャンセル規定）
2. 担当者「Kai」の口コミ → 有料口コミは冒頭だけ見えて、ぼかされている
3. `reader@example.com` でログイン → 有料口コミを購入 → 全文が読める
4. `writer@example.com` でログイン → 口コミを書く（有料も選べる）
5. `mod@example.com` でログイン → `/admin` で投稿を承認／差し戻し
6. `/account` で残高・購入した口コミ・返金申請

## テスト

```bash
npm test            # APIテスト
npm run typecheck   # 型チェック
npm run smoke       # 起動して主要ページ・APIが応答するか確認
npm run e2e:auth    # ブラウザ: 登録→メール確認→ログイン（要Chrome）
npm run e2e:flow    # ブラウザ: 投稿→審査→購入→返金→管理画面（要Chrome）
```

## 本番について

本番デプロイの手順は `docs/DEPLOY.md`（Docker + PostgreSQL + Caddy の低コスト構成）、運用体制は `docs/ORG.md` を参照。公開可否は `.kiro/steering/release-checklist.md` で管理します。

技術的に対応済み:
- メール送信（SMTP。本番は設定必須）
- 管理者の2段階認証（TOTP）
- Docker / docker-compose / CI / 本番ビルド

公開前に必ず確認（専門家・オーナー承認が必要）:
- 決済プロバイダ未接続（本番では購入を 503 で受け付けません）
- 出金は既定で無効（振込先登録・本人確認・税対応が未実装）
- 利用規約・特商法・プライバシーポリシーは仮の文面で、弁護士の確認が必要
