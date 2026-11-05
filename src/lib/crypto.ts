import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
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
