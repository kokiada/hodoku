-- 出金先の銀行口座。投稿者が受け取り残高を銀行振込で出金するために登録する。
-- 口座番号は機微情報のため暗号化して保存し、表示用に下4桁(masked)だけ平文で持つ。
-- 1ユーザー1口座（登録しなおすと上書き）。
CREATE TABLE bank_accounts (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bank_name       text NOT NULL,
  branch_name     text NOT NULL,
  account_type    text NOT NULL CHECK (account_type IN ('ordinary','checking')),  -- 普通 / 当座
  -- 口座番号は AES-256-GCM で暗号化（src/lib/crypto.ts encryptSecret）
  account_number_enc text NOT NULL,
  account_last4   text NOT NULL,     -- 表示用の下4桁
  account_holder_kana text NOT NULL, -- 口座名義（カナ）
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 出金申請に、処理時点の振込先スナップショットと振込メモを残せるようにする（監査・突合用）。
ALTER TABLE payout_requests ADD COLUMN bank_snapshot jsonb;
ALTER TABLE payout_requests ADD COLUMN paid_note text;
