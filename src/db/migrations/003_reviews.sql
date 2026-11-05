-- 口コミ本体。有料出品の条件判定に必要な情報を列として持つ
CREATE TABLE reviews (
  id                  uuid PRIMARY KEY,
  author_id           uuid NOT NULL REFERENCES users(id),
  therapist_id        uuid NOT NULL REFERENCES therapists(id),
  visited_when        text NOT NULL CHECK (visited_when IN ('this_month','last_month','few_months_ago')),
  course_minutes      int NOT NULL CHECK (course_minutes IN (60,90,120)),
  ng_precheck         text NOT NULL CHECK (ng_precheck IN ('on_booking','on_site','none')),
  total_matched       text NOT NULL CHECK (total_matched IN ('matched','slightly_off','very_off')),
  score_care          int NOT NULL CHECK (score_care BETWEEN 1 AND 5),
  score_comfort       int NOT NULL CHECK (score_comfort BETWEEN 1 AND 5),
  score_punctual       int NOT NULL CHECK (score_punctual BETWEEN 1 AND 5),
  gift_received       boolean NOT NULL DEFAULT false,
  body                text NOT NULL DEFAULT '',
  -- 'free' は無料公開、'paid' は有料出品の申請。NULLは未出品（body空のときなど想定しないが制約はしない）
  listing_kind        text NOT NULL DEFAULT 'free' CHECK (listing_kind IN ('free','paid')),
  price_yen           int CHECK (price_yen IN (100,200,300,500)),
  usage_verified       boolean NOT NULL DEFAULT false,  -- 利用確認済み（予約メール等の検証結果）
  -- status: pending=審査待り / published=公開 / rejected=非公開 / changes_requested=差し戻し
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected','changes_requested')),
  auto_flags           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 自動チェックの結果 例: ["similar","personal_info"]
  similarity_score     numeric(4,1),        -- 直近投稿との最大文面一致率(%)。審査キューの自動フラグに使う
  helpful_count        int NOT NULL DEFAULT 0,
  moderated_by         uuid REFERENCES users(id),
  moderated_at         timestamptz,
  moderation_reason    text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  published_at         timestamptz
);
CREATE INDEX reviews_therapist_idx ON reviews (therapist_id, status);
CREATE INDEX reviews_author_idx ON reviews (author_id);
CREATE INDEX reviews_status_created_idx ON reviews (status, created_at);

-- 「参考になった」。1ユーザー1件まで
CREATE TABLE review_helpful_votes (
  review_id   uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, user_id)
);

-- 通報
CREATE TABLE reports (
  id          uuid PRIMARY KEY,
  review_id   uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES users(id),
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at);

-- 購入。決済中・購入済みは同じ人が同じ口コミを2度買えない（失敗・返金後は再購入可）
CREATE TABLE purchases (
  id              uuid PRIMARY KEY,
  review_id       uuid NOT NULL REFERENCES reviews(id),
  buyer_id        uuid NOT NULL REFERENCES users(id),
  price_yen       int NOT NULL CHECK (price_yen > 0),
  fee_yen         int NOT NULL CHECK (fee_yen >= 0),         -- 運営の取り分（price_yenの10%・四捨五入）
  author_net_yen  int NOT NULL CHECK (author_net_yen >= 0),  -- 投稿者の取り分
  -- pending=決済中 / completed=購入済み / failed=決済失敗 / refunded=返金済み
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','refunded')),
  payment_ref     text,
  refunded_at     timestamptz,
  refund_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX purchases_review_buyer_uq ON purchases (review_id, buyer_id) WHERE status IN ('pending','completed');
CREATE INDEX purchases_buyer_idx ON purchases (buyer_id);
CREATE INDEX purchases_review_idx ON purchases (review_id);

-- 返金申請（購入者からの申請キュー。運営が審査する）
CREATE TABLE refund_requests (
  id            uuid PRIMARY KEY,
  purchase_id   uuid NOT NULL REFERENCES purchases(id),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','denied')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refund_requests_status_idx ON refund_requests (status, created_at);

-- 投稿者の残高元帳（追記のみ）。残高は合計で算出する
CREATE TABLE ledger_entries (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  amount_yen   int NOT NULL,     -- 正=入金（販売の取り分）、負=出金・返金による差し引き
  kind         text NOT NULL CHECK (kind IN ('sale','refund_clawback','payout','payout_reversal')),
  ref_id       uuid,             -- purchase_id / payout_request_id / review_unlocks.id（kind と組で一意）
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_user_idx ON ledger_entries (user_id);

-- 出金申請
CREATE TABLE payout_requests (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id),
  amount_yen    int NOT NULL CHECK (amount_yen > 0),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','denied')),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payout_requests_status_idx ON payout_requests (status, created_at);

CREATE UNIQUE INDEX refund_requests_open_uq ON refund_requests (purchase_id) WHERE status = 'open';
CREATE UNIQUE INDEX payout_requests_open_uq ON payout_requests (user_id) WHERE status = 'open';
-- 同じ購入・同じ種別の元帳記録は1回だけ（二重計上の最終防衛線）
CREATE UNIQUE INDEX ledger_entries_ref_uq ON ledger_entries (ref_id, kind) WHERE ref_id IS NOT NULL;
