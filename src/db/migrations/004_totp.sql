-- 管理者の2段階認証（TOTP）。
-- totp_secret は 001_core.sql で用意済み（base32のシークレットを保存）。
-- enrollment を確定した時刻を記録し、「シークレット生成済みだが未確定」と「有効」を区別する。
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
