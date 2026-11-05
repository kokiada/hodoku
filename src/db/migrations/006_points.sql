-- 風マネーポイント（ビットキャッシュ・チャージ型）。
-- 決済はビットキャッシュのみ。ユーザーはポイントをチャージし、有料口コミの閲覧でポイントを消費する。
-- 金額・ポイントはサーバーが決定し、二重計上は一意制約とトランザクションで防ぐ（円の購入系と同じ設計方針）。

-- チャージ注文。pending→(決済確定のWebhook)→completed。失敗は failed。
CREATE TABLE point_charges (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  pack_yen      int NOT NULL CHECK (pack_yen > 0),   -- 支払う円
  amount_pt     int NOT NULL CHECK (amount_pt > 0),  -- 付与ポイント
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  provider      text NOT NULL DEFAULT 'bitcash',
  provider_ref  text,                                -- 決済プロバイダ側の参照（Webhook照合に使う）
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX point_charges_user_idx ON point_charges (user_id, created_at DESC);
-- プロバイダ参照は決済1件につき一意（同じ通知での二重確定を防ぐ）
CREATE UNIQUE INDEX point_charges_provider_ref_uq ON point_charges (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- ポイント元帳（追記のみ）。残高は sum(amount_pt)。
--   charge          = +付与（チャージ確定）
--   spend           = −消費（有料口コミの閲覧）
--   spend_reversal  = +払い戻し（運営判断で消費を取り消す場合）
CREATE TABLE point_ledger (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  amount_pt    int NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('charge','spend','spend_reversal')),
  ref_id       uuid,          -- point_charges.id または review_unlocks.id
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX point_ledger_user_idx ON point_ledger (user_id);
-- 同じ参照・同じ種別は1回だけ（二重計上の最終防衛線）
CREATE UNIQUE INDEX point_ledger_ref_uq ON point_ledger (ref_id, kind) WHERE ref_id IS NOT NULL;

-- 閲覧権（エンタイトルメント）。ポイントで解放した有料口コミは恒久的に読める。
CREATE TABLE review_unlocks (
  id           uuid PRIMARY KEY,
  review_id    uuid NOT NULL REFERENCES reviews(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  spent_pt     int NOT NULL CHECK (spent_pt > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- 同じ口コミを同じ人が二重に解放しない
CREATE UNIQUE INDEX review_unlocks_uq ON review_unlocks (review_id, user_id);
CREATE INDEX review_unlocks_user_idx ON review_unlocks (user_id);
