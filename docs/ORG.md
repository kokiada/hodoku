# Hodoku 運営組織（エージェント体制）

最終更新: 2026-11-05

このドキュメントは、Hodoku ウェブアプリ（`hodoku-app/`）を開発・運用する「会社組織」を、Kiro のカスタムエージェント（`.kiro/agents/*.json`）として定義したものです。実在の人間を雇うのではなく、**役割・権限・責任範囲を持った AI エージェントの集合と、それを束ねる運用ルール**で構成します。

## 体制図

```
あなた（オーナー / 意思決定者・最終承認）
        │
   マネージャー（Kiro 本体 / 既定エージェント）
        │  ── タスクを分解し、適切なエージェントに委譲し、成果を統合して報告する
        ├── cto-architect       技術方針・設計・コードレビューの承認
        ├── backend-engineer    Fastify / DB / API / ドメインロジックの実装
        ├── sre-infra           Docker・CI・本番構成・デプロイ・監視
        ├── security-engineer   認証・CSRF・CSP・TOTP・脆弱性レビュー
        ├── qa-engineer         テスト設計・追加・回帰・smoke / e2e 実行
        ├── legal-compliance    法務文面・年齢確認・特商法のレビュー（提案のみ）
        └── payments-finance    決済差し替え口・出金・元帳・税区分の整理（提案のみ）
```

## 各ロールの責任範囲（RACI 概略）

| 領域 | 主担当 (R) | 承認 (A) | 相談 (C) |
|---|---|---|---|
| アーキテクチャ・技術選定 | cto-architect | オーナー | 全員 |
| API / DB / ドメイン実装 | backend-engineer | cto-architect | security, qa |
| Docker / CI / デプロイ / 監視 | sre-infra | cto-architect | security |
| 認証 / 権限 / 暗号 / TOTP | security-engineer | cto-architect | backend |
| テスト・品質ゲート | qa-engineer | cto-architect | backend, sre |
| 法務文面 / 年齢確認要件 | legal-compliance | **オーナー + 実在の弁護士** | security |
| 決済接続 / 出金 / 税務 | payments-finance | **オーナー + 実在の税理士・弁護士** | backend, legal |

> **重要:** `legal-compliance` と `payments-finance` は提案・ドラフト・整理までしか行いません。法的な確定・決済審査・本人確認・税務判断は AI では完了できず、実在の専門家とオーナーの承認が必須です。これらは `.kiro/steering/release-checklist.md` の必須項目として管理します。

## マネージャー（Kiro 本体）の運用ルール

1. **受付と分解**: オーナーの依頼を受け、どのロールの仕事かを判断してタスクに分解する。
2. **委譲**: 単純な調査・読み取りは自分で行い、まとまった実装・レビューは該当ロールのエージェントに委譲する（`/agent swap` でエージェントを切り替える、またはサブエージェントとして起動する）。
3. **品質ゲート**: 実装系の変更は必ず `npm run typecheck` と `npm test` が緑であることを確認してから「完了」とする（`.kiro/steering/engineering.md`）。
4. **承認の線引き**: 破壊的操作・本番反映・法務/決済/税務に関わる判断は、必ずオーナーに確認してから進める。
5. **引き継ぎ**: 作業の節目で `HANDOFF.md` / `docs/` を更新し、次の担当が続きから着手できる状態を保つ。

## エージェントの起動方法

```bash
# 特定ロールで対話を開始
kiro-cli --agent backend-engineer

# セッション中にロールを切り替え
/agent swap sre-infra
```

各エージェント定義は `.kiro/agents/<name>.json`。権限（使えるツール・書き込み可能パス）はロールごとに絞ってあります。
