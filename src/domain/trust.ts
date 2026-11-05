export type TrustLevel = 'high' | 'mid' | 'low';

/** 店舗・担当者の信頼度。口コミ件数が少ない、または利用確認済みの割合が低いと「要確認」 */
export function trustLevel(published: number, verified: number): TrustLevel {
  if (published < 10) return 'low';
  const ratio = verified / published;
  if (ratio < 0.4) return 'low';
  if (ratio >= 0.7 && published >= 25) return 'high';
  return 'mid';
}
