-- TOTP の堅牢化。
-- 1) enrollment 中の新シークレットは staging 列に置き、確定するまで現役の totp_secret を壊さない
--    （有効な2段階認証を、コード無しの再setupで無効化できてしまう経路を塞ぐ）。
-- 2) 直近で受理した TOTP カウンタを保存し、同一コードの使い回し（リプレイ）を拒否する。
ALTER TABLE users ADD COLUMN totp_secret_pending text;
ALTER TABLE users ADD COLUMN totp_last_counter bigint;
