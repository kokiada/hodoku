import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 6238 TOTP（SHA-1・6桁・30秒）。外部依存を増やさず node:crypto のみで実装する。

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** バイト列を RFC 4648 base32（パディングなし）に変換 */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** base32 文字列をバイト列に戻す（大文字小文字・空白・パディングを許容） */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/u, '').replace(/\s+/gu, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新しい TOTP シークレット（base32）を生成する。既定20バイト=160bit */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

const STEP_SECONDS = 30;
const DIGITS = 6;

/** 指定カウンタに対する HOTP 値（RFC 4226）を6桁ゼロ埋めで返す */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // counter は 2^53 未満の整数前提。上位32bit/下位32bitに分けて書く
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** 現在時刻の TOTP コードを生成する（テスト・enrollment確認に使用） */
export function generateTotp(secretBase32: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * コードを検証する。時計ずれを許容するため ±window ステップを試す（既定±1=前後30秒）。
 * タイミング攻撃を避けるため timingSafeEqual で比較する。
 */
export function verifyTotp(secretBase32: string, code: string, atMs = Date.now(), window = 1): boolean {
  return verifyTotpCounter(secretBase32, code, atMs, window) !== null;
}

/**
 * verifyTotp と同じだが、一致したカウンタ値を返す（不一致は null）。
 * 受理カウンタを保存して同一コードのリプレイを防ぐために使う。
 * minCounter を指定すると、それ以下のカウンタのコードは拒否する（使い回し対策）。
 */
export function verifyTotpCounter(secretBase32: string, code: string, atMs = Date.now(), window = 1, minCounter = -Infinity): number | null {
  const normalized = code.replace(/\s+/gu, '');
  if (!/^\d{6}$/u.test(normalized)) return null;
  const secret = base32Decode(secretBase32);
  const base = Math.floor(atMs / 1000 / STEP_SECONDS);
  const target = Buffer.from(normalized);
  for (let w = -window; w <= window; w++) {
    const counter = base + w;
    if (counter <= minCounter) continue; // 既に使われたコードは拒否
    const candidate = Buffer.from(hotp(secret, counter));
    if (candidate.length === target.length && timingSafeEqual(candidate, target)) return counter;
  }
  return null;
}

/** 認証アプリ登録用の otpauth:// URI を組み立てる */
export function totpUri(secretBase32: string, account: string, issuer = 'Hodoku'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
