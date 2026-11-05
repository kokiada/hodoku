CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           text NOT NULL,
  nickname        text NOT NULL,
  password_hash   text NOT NULL,
  role            text NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  plan            text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','standard','premium')),
  email_verified_at timestamptz,
  totp_secret     text,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
-- メール・ニックネームは大文字小文字を区別せず一意（退会済みは除く）
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_nickname_uq ON users (lower(nickname)) WHERE deleted_at IS NULL;

-- セッションIDそのものは保存せず、SHA-256ハッシュのみ保存する
CREATE TABLE sessions (
  id_hash     text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- メール確認・パスワード再設定。トークンはハッシュのみ保存、1回限り
CREATE TABLE email_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- 管理操作・金銭に関わる操作の記録（追記のみ）
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  target      text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
