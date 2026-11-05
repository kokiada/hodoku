-- 店舗。総額の内訳・安全対応・キャンセル規定は正規化せず構造化JSONで持つ
-- （運営が随時更新する静的な掲載情報で、検索条件には別カラムを使うため）
CREATE TABLE shops (
  id              uuid PRIMARY KEY,
  slug            text NOT NULL,
  name            text NOT NULL,
  area            text NOT NULL,          -- 表示用（例: 恵比寿駅 徒歩圏・出張／ホテル）
  station         text NOT NULL,           -- 検索条件用の正規化駅名（例: 恵比寿）
  base_price_yen  int NOT NULL CHECK (base_price_yen >= 0),   -- 60分の基本コース料金
  price_step_yen  int NOT NULL CHECK (price_step_yen >= 0),   -- 30分延長ごとの加算
  nomination_fee_yen int NOT NULL DEFAULT 0,
  transport_fee_yen  int NOT NULL DEFAULT 0,
  extension_fee_yen  int NOT NULL DEFAULT 0,
  has_ng_precheck     boolean NOT NULL DEFAULT false,
  has_support_desk     boolean NOT NULL DEFAULT false,
  free_change_hours    int,               -- 無料で変更できる時間数（前日なら24超などで表現。NULL=無料変更なし
  first_time_friendly  boolean NOT NULL DEFAULT false,
  safety_notes    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{title,body,source,ok}]
  cancel_policy   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{label,feePercent}]
  last_checked_at date,
  published       boolean NOT NULL DEFAULT true,
  is_sample       boolean NOT NULL DEFAULT false,   -- 開発・デモ用の架空データ。画面に「架空のサンプル」と表示する
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shops_slug_uq ON shops (slug);
CREATE INDEX shops_station_idx ON shops (station);

-- 担当者（セラピスト）。写真は使わず質感画像のスロット名を持つ
CREATE TABLE therapists (
  id          uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,              -- 仮名
  bio         text NOT NULL DEFAULT '',
  texture     text NOT NULL DEFAULT 'a',  -- CSSの .tex / .tex.b / .tex.c に対応
  published   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX therapists_slug_uq ON therapists (slug);
CREATE INDEX therapists_shop_idx ON therapists (shop_id);
