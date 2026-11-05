import { describe, expect, it } from 'vitest';
import {
  autoFlags, courseFee, hasMinorHint, paidIneligibleReasons, previewOf, similarityPercent, splitPrice, totalFee,
} from '../src/domain/rules.js';

const lumen = { basePriceYen: 10400, priceStepYen: 4000, nominationFeeYen: 2000, transportFeeYen: 2000 };

describe('総額計算', () => {
  it('モックと同じ金額になる（Atelier Lumen 90分=¥18,400）', () => {
    expect(courseFee(lumen, 90)).toBe(14400);
    expect(totalFee(lumen, 60)).toBe(14400);
    expect(totalFee(lumen, 90)).toBe(18400);
    expect(totalFee(lumen, 120)).toBe(22400);
  });
  it('30分刻みでないコースは拒否する', () => {
    expect(() => courseFee(lumen, 75)).toThrow(RangeError);
    expect(() => courseFee(lumen, 30)).toThrow(RangeError);
  });
});

describe('手数料と取り分', () => {
  it('価格帯ごとに10%/90%で分かれ、合計が必ず販売価格に一致する', () => {
    for (const [p, fee] of [[100, 10], [200, 20], [300, 30], [500, 50]] as const) {
      const s = splitPrice(p, 10);
      expect(s).toEqual({ feeYen: fee, authorNetYen: p - fee });
      expect(s.feeYen + s.authorNetYen).toBe(p);
    }
  });
  it('端数が出る場合も合計は崩れない', () => {
    const s = splitPrice(333, 10);
    expect(s.feeYen + s.authorNetYen).toBe(333);
  });
  it('不正な価格は拒否する', () => {
    expect(() => splitPrice(0, 10)).toThrow();
    expect(() => splitPrice(1.5, 10)).toThrow();
  });
});

describe('文面の類似度', () => {
  const a = '予約のときに苦手なことを丁寧に聞いてもらえて、当日は緊張が少しずつほどけました。総額も事前の案内どおりでした。';
  it('同一文は100%、句読点・空白の違いは無視される', () => {
    expect(similarityPercent(a, a)).toBe(100);
    expect(similarityPercent(a, a.replace(/、/g, ' ，'))).toBe(100);
  });
  it('一部を言い換えた文は高く、無関係な文は低い', () => {
    expect(similarityPercent(a, a.replace('丁寧に', 'ていねいに'))).toBeGreaterThan(60);
    expect(similarityPercent(a, '駅から近くて道に迷わず、受付の方の対応もすばやかったです。')).toBeLessThan(10);
  });
  it('短すぎる文は0', () => { expect(similarityPercent('ab', 'ab')).toBe(0); });
});

describe('自動フラグ', () => {
  it('電話番号・URL・メールを個人情報として検出する', () => {
    expect(autoFlags('03-1234-5678に連絡', { similarity: 0, giftReceived: false })).toContain('personal_info');
    expect(autoFlags('https://example.com を見て', { similarity: 0, giftReceived: false })).toContain('personal_info');
    expect(autoFlags('a@b.co まで', { similarity: 0, giftReceived: false })).toContain('personal_info');
  });
  it('誇大表現・類似・特典を検出し、普通の文は無フラグ', () => {
    expect(autoFlags('絶対におすすめです', { similarity: 0, giftReceived: false })).toContain('exaggeration');
    expect(autoFlags('x', { similarity: 82, giftReceived: false })).toContain('similar');
    expect(autoFlags('x', { similarity: 0, giftReceived: true })).toContain('gift');
    expect(autoFlags('時間どおりに終わり、落ち着いて過ごせました。', { similarity: 10, giftReceived: false })).toEqual([]);
  });
  it('18歳未満を連想させる表現を検出する', () => {
    for (const t of ['女子高生みたいな', '未成年', 'ＪＫ風']) expect(hasMinorHint(t), t).toBe(true);
    expect(hasMinorHint('落ち着いた雰囲気でした')).toBe(false);
  });
});

describe('有料出品の条件', () => {
  const ok = { usageVerified: true, giftReceived: false, bodyChars: 150, similarity: 5, flags: [] as string[] };
  it('すべて満たせば理由なし', () => { expect(paidIneligibleReasons(ok)).toEqual([]); });
  it('未確認・特典・短文・類似・個人情報はそれぞれ理由になる', () => {
    expect(paidIneligibleReasons({ ...ok, usageVerified: false })).toHaveLength(1);
    expect(paidIneligibleReasons({ ...ok, giftReceived: true })).toHaveLength(1);
    expect(paidIneligibleReasons({ ...ok, bodyChars: 119 })).toHaveLength(1);
    expect(paidIneligibleReasons({ ...ok, similarity: 70 })).toHaveLength(1);
    expect(paidIneligibleReasons({ ...ok, flags: ['personal_info'] })).toHaveLength(1);
    expect(paidIneligibleReasons({ ...ok, bodyChars: 0, usageVerified: false })).toHaveLength(2);
  });
  it('120字ちょうどは可', () => { expect(paidIneligibleReasons({ ...ok, bodyChars: 120 })).toEqual([]); });
});

describe('購入前プレビュー', () => {
  it('50字までに切り、全文は含まれない', () => {
    const body = 'あ'.repeat(40) + 'い'.repeat(40);
    const p = previewOf(body);
    expect(Array.from(p)).toHaveLength(50);
    expect(p).not.toContain('い'.repeat(41));
    expect(previewOf('短い')).toBe('短い');
  });
});
