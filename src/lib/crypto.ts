import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const N = 32768, R = 8, P = 1, KEYLEN = 64;
const OPTS = { N, r: R, p: P, maxmem: 128 * 1024 * 1024 };

/** scrypt でパスワードをハッシュ。形式: scrypt$N$r$p$salt$hash */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(pw.normalize('NFKC'), salt, KEYLEN, OPTS);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const dk = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    N: +n, r: +r, p: +p, maxmem: 128 * 1024 * 1024,
  });
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

/** 推測不能なランダムトークン（URL安全） */
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** HMAC署名（年齢確認Cookieなど） */
export const sign = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- 対称暗号（保存時の機微情報の暗号化。例: 銀行口座番号） ---
// 鍵は秘密(SESSION_SECRET等)から scryptSync で導出。形式: v1.<iv>.<tag>.<cipher>（すべてbase64url）

const encKeyCache = new Map<string, Buffer>();
function encKey(secret: string): Buffer {
  let k = encKeyCache.get(secret);
  if (!k) { k = scryptSync(secret, 'hodoku-enc-v1', 32); encKeyCache.set(secret, k); }
  return k;
}

/** AES-256-GCM で暗号化する。平文が空なら空文字を返す */
export function encryptSecret(secret: string, plaintext: string): string {
  if (plaintext === '') return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

/** encryptSecret の復号。改ざん時は例外 */
export function decryptSecret(secret: string, stored: string): string {
  if (stored === '') return '';
  const [v, ivB, tagB, dataB] = stored.split('.');
  if (v !== 'v1' || !ivB || !tagB || !dataB) throw new Error('暗号文の形式が不正です');
  const decipher = createDecipheriv('aes-256-gcm', encKey(secret), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8');
}
