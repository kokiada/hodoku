import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/index.js';
import type { Mailer } from '../lib/mailer.js';
import { hashPassword, verifyPassword, newToken, sha256, sign, safeEqual } from '../lib/crypto.js';
import { generateTotpSecret, verifyTotpCounter, totpUri } from '../lib/totp.js';

export class AuthError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
/** TOTPチャレンジ（パスワード通過済みの証明）の有効期間 */
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface SessionUser {
  id: string; email: string; nickname: string; role: 'user' | 'moderator' | 'admin'; plan: 'free' | 'standard' | 'premium';
}

/** ログイン結果。TOTP有効な利用者はパスワード通過後にコード入力が必要 */
export type LoginResult =
  | { ok: true; sessionId: string; user: SessionUser }
  | { ok: false; totpRequired: true; challenge: string };

/** ニックネームに本名・連絡先らしきパターンが無いかの簡易チェック（最終判断は投稿ガイドラインの審査） */
const looksLikeContact = (s: string) => /@|https?:\/\/|\b0\d{1,4}-?\d{2,4}-?\d{3,4}\b/.test(s);

export class AuthService {
  constructor(private db: Queryable, private mailer: Mailer, private baseUrl: string, private sessionSecret: string) {}

  async register(email: string, nickname: string, password: string): Promise<{ userId: string }> {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new AuthError('invalid_email', 'メールアドレスの形式を確認してください');
    if (nickname.trim().length < 1 || nickname.length > 40) throw new AuthError('invalid_nickname', 'ニックネームを入力してください');
    if (looksLikeContact(nickname)) throw new AuthError('unsafe_nickname', '本名や連絡先はニックネームに使えません');
    if (password.length < 8) throw new AuthError('weak_password', 'パスワードは8文字以上にしてください');

    const dup = await this.db.query('SELECT 1 FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [e]);
    if (dup.rowCount > 0) throw new AuthError('email_taken', 'このメールアドレスは既に登録されています');

    const nickDup = await this.db.query('SELECT 1 FROM users WHERE lower(nickname)=lower($1) AND deleted_at IS NULL', [nickname.trim()]);
    if (nickDup.rowCount > 0) throw new AuthError('nickname_taken', 'このニックネームは使われています');

    const id = randomUUID();
    const hash = await hashPassword(password);
    try {
      await this.db.query(
        `INSERT INTO users (id, email, nickname, password_hash) VALUES ($1,$2,$3,$4)`,
        [id, e, nickname.trim(), hash],
      );
    } catch (err) {
      // 同時登録の競合は一意制約が最終防衛線になる
      if ((err as { code?: string }).code === '23505') throw new AuthError('email_taken', 'このメールアドレスまたはニックネームは既に使われています');
      throw err;
    }
    await this.sendVerifyEmail(id, e);
    return { userId: id };
  }

  async sendVerifyEmail(userId: string, email: string) {
    const token = newToken();
    await this.db.query(
      `INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES ($1,$2,'verify',$3)`,
      [sha256(token), userId, new Date(Date.now() + VERIFY_TTL_MS)],
    );
    const link = `${this.baseUrl}/verify?token=${token}`;
    await this.mailer.send({ to: email, subject: 'Hodoku 登録の確認', text: `以下のリンクから登録を完了してください（24時間有効）。\n${link}` });
  }

  async verifyEmail(token: string): Promise<void> {
    const hash = sha256(token);
    const row = await this.db.query<{ user_id: string; expires_at: string; used_at: string | null }>(
      `SELECT user_id, expires_at, used_at FROM email_tokens WHERE token_hash=$1 AND kind='verify'`, [hash],
    );
    const t = row.rows[0];
    if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new AuthError('invalid_token', 'リンクが無効か期限切れです');
    await this.db.query(`UPDATE email_tokens SET used_at=now() WHERE token_hash=$1`, [hash]);
    await this.db.query(`UPDATE users SET email_verified_at=now() WHERE id=$1`, [t.user_id]);
  }

  async login(email: string, password: string, userAgent?: string): Promise<LoginResult> {
    const e = email.trim().toLowerCase();
    const row = await this.db.query<{
      id: string; email: string; nickname: string; password_hash: string; role: 'user' | 'moderator' | 'admin';
      plan: 'free' | 'standard' | 'premium'; failed_logins: number; locked_until: string | null; email_verified_at: string | null;
      totp_enabled_at: string | null;
    }>(`SELECT id,email,nickname,password_hash,role,plan,failed_logins,locked_until,email_verified_at,totp_enabled_at
        FROM users WHERE lower(email)=$1 AND deleted_at IS NULL`, [e]);
    const u = row.rows[0];
    // ユーザーが存在しない場合も同じ処理時間・同じエラーにして、登録メールの存在を推測されないようにする
    const fake = { password_hash: '$scrypt$0$0$0$x$x' };
    const ok = await verifyPassword(password, u?.password_hash ?? fake.password_hash);
    if (!u || !ok) {
      if (u) await this.recordFailure(u.id, u.failed_logins);
      throw new AuthError('invalid_credentials', 'メールアドレスまたはパスワードが違います');
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new AuthError('locked', 'ログインが一時的にロックされています。しばらくしてから再度お試しください');
    }
    if (!u.email_verified_at) throw new AuthError('unverified', 'メールアドレスの確認が完了していません');

    await this.db.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);

    const sessionUser: SessionUser = { id: u.id, email: u.email, nickname: u.nickname, role: u.role, plan: u.plan };
    // TOTP が有効なら、ここではセッションを発行せずコード入力を要求する
    if (u.totp_enabled_at) {
      return { ok: false, totpRequired: true, challenge: this.issueTotpChallenge(u.id) };
    }
    const sessionId = await this.createSession(u.id, userAgent);
    return { ok: true, sessionId, user: sessionUser };
  }

  /** TOTPチャレンジの検証後にログインを完了する */
  async completeLoginWithTotp(challenge: string, code: string, userAgent?: string): Promise<{ sessionId: string; user: SessionUser }> {
    const userId = this.verifyTotpChallenge(challenge);
    if (!userId) throw new AuthError('totp_challenge_invalid', '認証をやり直してください');
    const row = await this.db.query<{
      id: string; email: string; nickname: string; role: 'user' | 'moderator' | 'admin';
      plan: 'free' | 'standard' | 'premium'; totp_secret: string | null; totp_enabled_at: string | null;
      totp_last_counter: string | null; failed_logins: number; locked_until: string | null;
    }>(`SELECT id,email,nickname,role,plan,totp_secret,totp_enabled_at,totp_last_counter,failed_logins,locked_until
        FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId]);
    const u = row.rows[0];
    if (!u || !u.totp_enabled_at || !u.totp_secret) throw new AuthError('totp_challenge_invalid', '認証をやり直してください');
    // パスワード通過後にロックされた場合もここで弾く（チャレンジはロック状態に縛られない）
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new AuthError('locked', 'ログインが一時的にロックされています。しばらくしてから再度お試しください');
    }
    // リプレイ対策: 直近で受理したカウンタ以下のコードは拒否する
    const minCounter = u.totp_last_counter != null ? Number(u.totp_last_counter) : -Infinity;
    const counter = verifyTotpCounter(u.totp_secret, code, Date.now(), 1, minCounter);
    if (counter === null) {
      await this.recordFailure(u.id, u.failed_logins); // コード総当たりにもロックアウトを効かせる
      throw new AuthError('totp_invalid', '認証コードが正しくありません');
    }
    await this.db.query('UPDATE users SET failed_logins=0, locked_until=NULL, totp_last_counter=$2 WHERE id=$1', [u.id, counter]);
    const sessionId = await this.createSession(u.id, userAgent);
    return { sessionId, user: { id: u.id, email: u.email, nickname: u.nickname, role: u.role, plan: u.plan } };
  }

  private async createSession(userId: string, userAgent?: string): Promise<string> {
    const sessionId = newToken();
    await this.db.query(
      `INSERT INTO sessions (id_hash, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)`,
      [sha256(sessionId), userId, new Date(Date.now() + SESSION_TTL_MS), userAgent ?? null],
    );
    return sessionId;
  }

  // --- TOTP チャレンジ（ステートレス・HMAC署名） ---
  private issueTotpChallenge(userId: string): string {
    const exp = Date.now() + TOTP_CHALLENGE_TTL_MS;
    const payload = `${userId}.${exp}`;
    return `${payload}.${sign(this.sessionSecret, payload)}`;
  }

  private verifyTotpChallenge(challenge: string): string | null {
    const parts = challenge.split('.');
    if (parts.length !== 3) return null;
    const [userId, expStr, mac] = parts as [string, string, string];
    const payload = `${userId}.${expStr}`;
    if (!safeEqual(mac, sign(this.sessionSecret, payload))) return null;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || exp < Date.now()) return null;
    return userId;
  }

  // --- TOTP 登録（運営スタッフ向け） ---
  /**
   * 新しいシークレットを生成し、確定前の staging 列(totp_secret_pending)に保存する。
   * 既に TOTP が有効な場合でも、現役の totp_secret / totp_enabled_at には一切触れない
   * （コード無しの再setupで2段階認証を無効化できる経路を塞ぐ）。
   */
  async beginTotpEnrollment(userId: string, accountEmail: string): Promise<{ secret: string; uri: string }> {
    const secret = generateTotpSecret();
    await this.db.query(`UPDATE users SET totp_secret_pending=$1 WHERE id=$2`, [secret, userId]);
    return { secret, uri: totpUri(secret, accountEmail) };
  }

  /** staging のシークレットをアプリのコードで確定し、現役に昇格させる。以後ログインにTOTPが必須になる */
  async confirmTotpEnrollment(userId: string, code: string): Promise<void> {
    const row = await this.db.query<{ totp_secret_pending: string | null; failed_logins: number; locked_until: string | null }>(
      `SELECT totp_secret_pending, failed_logins, locked_until FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId]);
    const u = row.rows[0];
    if (!u || !u.totp_secret_pending) throw new AuthError('totp_not_started', '先に2段階認証の設定を開始してください');
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AuthError('locked', '一時的にロックされています。しばらくしてからお試しください');
    const counter = verifyTotpCounter(u.totp_secret_pending, code);
    if (counter === null) {
      await this.recordFailure(userId, u.failed_logins);
      throw new AuthError('totp_invalid', '認証コードが正しくありません');
    }
    // pending を現役へ昇格。古いシークレットは上書きされる
    await this.db.query(
      `UPDATE users SET totp_secret=totp_secret_pending, totp_secret_pending=NULL, totp_enabled_at=now(), totp_last_counter=$2, failed_logins=0, locked_until=NULL WHERE id=$1`,
      [userId, counter],
    );
  }

  /** TOTP を無効化する（確認コード必須） */
  async disableTotp(userId: string, code: string): Promise<void> {
    const row = await this.db.query<{ totp_secret: string | null; totp_enabled_at: string | null; totp_last_counter: string | null; failed_logins: number; locked_until: string | null }>(
      `SELECT totp_secret, totp_enabled_at, totp_last_counter, failed_logins, locked_until FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId]);
    const u = row.rows[0];
    if (!u || !u.totp_enabled_at || !u.totp_secret) throw new AuthError('totp_not_enabled', '2段階認証は有効ではありません');
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new AuthError('locked', '一時的にロックされています。しばらくしてからお試しください');
    const minCounter = u.totp_last_counter != null ? Number(u.totp_last_counter) : -Infinity;
    const counter = verifyTotpCounter(u.totp_secret, code, Date.now(), 1, minCounter);
    if (counter === null) {
      await this.recordFailure(userId, u.failed_logins);
      throw new AuthError('totp_invalid', '認証コードが正しくありません');
    }
    await this.db.query(`UPDATE users SET totp_secret=NULL, totp_secret_pending=NULL, totp_enabled_at=NULL, totp_last_counter=NULL, failed_logins=0, locked_until=NULL WHERE id=$1`, [userId]);
  }

  /** TOTP が有効かどうか（画面表示用） */
  async totpStatus(userId: string): Promise<{ enabled: boolean }> {
    const row = await this.db.query<{ totp_enabled_at: string | null }>(
      `SELECT totp_enabled_at FROM users WHERE id=$1 AND deleted_at IS NULL`, [userId]);
    return { enabled: !!row.rows[0]?.totp_enabled_at };
  }

  private async recordFailure(userId: string, current: number) {
    const next = current + 1;
    if (next >= LOCK_AFTER) {
      await this.db.query('UPDATE users SET failed_logins=0, locked_until=$2 WHERE id=$1', [userId, new Date(Date.now() + LOCK_MS)]);
    } else {
      await this.db.query('UPDATE users SET failed_logins=$2 WHERE id=$1', [userId, next]);
    }
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query('DELETE FROM sessions WHERE id_hash=$1', [sha256(sessionId)]);
  }

  async currentUser(sessionId: string): Promise<SessionUser | null> {
    const row = await this.db.query<SessionUser & { expires_at: string }>(
      `SELECT u.id,u.email,u.nickname,u.role,u.plan,s.expires_at
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.id_hash=$1 AND u.deleted_at IS NULL`, [sha256(sessionId)],
    );
    const r = row.rows[0];
    if (!r || new Date(r.expires_at) < new Date()) return null;
    return { id: r.id, email: r.email, nickname: r.nickname, role: r.role, plan: r.plan };
  }

  async requestPasswordReset(email: string): Promise<void> {
    const e = email.trim().toLowerCase();
    const row = await this.db.query<{ id: string }>('SELECT id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL', [e]);
    const u = row.rows[0];
    if (!u) return; // メール有無を外部に漏らさない
    const token = newToken();
    await this.db.query(
      `INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES ($1,$2,'reset',$3)`,
      [sha256(token), u.id, new Date(Date.now() + RESET_TTL_MS)],
    );
    const link = `${this.baseUrl}/reset-password?token=${token}`;
    await this.mailer.send({ to: e, subject: 'Hodoku パスワードの再設定', text: `以下のリンクから再設定してください（1時間有効）。\n${link}` });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw new AuthError('weak_password', 'パスワードは8文字以上にしてください');
    const hash = sha256(token);
    const row = await this.db.query<{ user_id: string; expires_at: string; used_at: string | null }>(
      `SELECT user_id, expires_at, used_at FROM email_tokens WHERE token_hash=$1 AND kind='reset'`, [hash],
    );
    const t = row.rows[0];
    if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new AuthError('invalid_token', 'リンクが無効か期限切れです');
    await this.db.query(`UPDATE email_tokens SET used_at=now() WHERE token_hash=$1`, [hash]);
    const pwHash = await hashPassword(newPassword);
    await this.db.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [pwHash, t.user_id]);
    await this.db.query(`DELETE FROM sessions WHERE user_id=$1`, [t.user_id]); // 全端末からログアウト
  }
}
