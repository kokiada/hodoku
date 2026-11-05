/** 口コミ・価格に関する業務ルール。DBやHTTPに依存しない純粋関数にして、テストで固定する */

export const PRICE_TIERS = [100, 200, 300, 500] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

/** 有料出品に必要な本文の最小文字数 */
export const MIN_PAID_BODY_CHARS = 120;
export const MAX_BODY_CHARS = 1000;
/** この一致率(%)以上は「類似文面」として審査キューにフラグを立てる */
export const SIMILARITY_FLAG_THRESHOLD = 70;
/** 購入前に見せる冒頭の文字数 */
export const PREVIEW_CHARS = 50;

export const charLength = (s: string) => Array.from(s).length;

export interface ShopPricing {
  basePriceYen: number; priceStepYen: number; nominationFeeYen: number; transportFeeYen: number;
}

/** 総額 = コース料金 + 指名料 + 交通費。コース料金は60分基準で30分ごとに加算 */
export function courseFee(p: ShopPricing, minutes: number): number {
  if (minutes < 60 || (minutes - 60) % 30 !== 0) throw new RangeError('コースは60分以上、30分刻みです');
  return p.basePriceYen + ((minutes - 60) / 30) * p.priceStepYen;
}
export const totalFee = (p: ShopPricing, minutes: number) => courseFee(p, minutes) + p.nominationFeeYen + p.transportFeeYen;

/** 販売価格を運営手数料と投稿者の取り分に分ける。端数は手数料側で四捨五入し、合計は必ず販売価格に一致する */
export function splitPrice(priceYen: number, feePercent: number): { feeYen: number; authorNetYen: number } {
  if (!Number.isInteger(priceYen) || priceYen <= 0) throw new RangeError('価格は正の整数です');
  const feeYen = Math.round((priceYen * feePercent) / 100);
  return { feeYen, authorNetYen: priceYen - feeYen };
}

/** 文字3-gramのJaccard係数を0〜100で返す。空白・句読点は無視して表記ゆれの影響を減らす */
export function similarityPercent(a: string, b: string): number {
  const grams = (s: string) => {
    const t = Array.from(s.normalize('NFKC').replace(/[\s、。，．,.!?！？「」『』（）()]/g, '').toLowerCase());
    const set = new Set<string>();
    for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3).join(''));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return Math.round((inter / (A.size + B.size - inter)) * 1000) / 10;
}

export type AutoFlag = 'similar' | 'personal_info' | 'exaggeration' | 'gift';

const PHONE = /0\d{1,4}[-\s]?\d{2,4}[-\s]?\d{3,4}/;
const URL_OR_MAIL = /https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+/i;
const EXAGGERATION = /(絶対|必ず|100\s*[%％]|最高|最強|間違いなく|誰でも)/;
/** 18歳未満を連想させる表現。ガイドライン上、公開しない（自動で投稿を拒否する） */
const MINOR_HINT = /(未成年|18歳未満|十代|10代|JK|JC|JS|女子高生|女子中学生|中学生|高校生|少女|ロリ)/i;

export const hasMinorHint = (text: string) => MINOR_HINT.test(text.normalize('NFKC'));

export function autoFlags(body: string, opts: { similarity: number; giftReceived: boolean }): AutoFlag[] {
  const t = body.normalize('NFKC');
  const flags: AutoFlag[] = [];
  if (opts.similarity >= SIMILARITY_FLAG_THRESHOLD) flags.push('similar');
  if (PHONE.test(t) || URL_OR_MAIL.test(t)) flags.push('personal_info');
  if (EXAGGERATION.test(t)) flags.push('exaggeration');
  if (opts.giftReceived) flags.push('gift');
  return flags;
}

export interface PaidEligibilityInput {
  usageVerified: boolean; giftReceived: boolean; bodyChars: number; similarity: number; flags: string[];
}

/** 有料出品の条件。満たさない理由を日本語で返す（空なら出品可） */
export function paidIneligibleReasons(i: PaidEligibilityInput): string[] {
  const r: string[] = [];
  if (!i.usageVerified) r.push('利用が確認できていません');
  if (i.giftReceived) r.push('店舗から特典を受け取っています');
  if (i.bodyChars < MIN_PAID_BODY_CHARS) r.push(`本文が${MIN_PAID_BODY_CHARS}字に足りません（${i.bodyChars}字）`);
  if (i.similarity >= SIMILARITY_FLAG_THRESHOLD) r.push('ほかの投稿と文面が似ています');
  if (i.flags.includes('personal_info')) r.push('個人情報・連絡先らしい記述があります');
  return r;
}

/** 購入前に見せる本文（冒頭のみ）。全文はサーバーから出さない */
export function previewOf(body: string): string {
  const chars = Array.from(body);
  return chars.length <= PREVIEW_CHARS ? body : chars.slice(0, PREVIEW_CHARS).join('');
}
