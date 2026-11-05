import { randomUUID } from 'node:crypto';
import type { Queryable } from './index.js';

/** モック（04_mock_html）に出ていた架空の店舗・担当者を、開発・デモ用の初期データとして投入する */
export async function seedCatalog(db: Queryable): Promise<void> {
  const existing = await db.query('SELECT 1 FROM shops LIMIT 1');
  if (existing.rowCount > 0) return;

  const shops = [
    {
      slug: 'atelier-lumen', name: 'Atelier Lumen', area: '恵比寿駅 徒歩圏・出張／ホテル', station: '恵比寿',
      base: 10400, step: 4000, nomination: 2000, transport: 2000, extension: 5000,
      ng: true, desk: true, freeChangeHours: 24, firstTime: true, lastChecked: '2026-10-30',
      safety: [
        { title: 'NGを予約時に確認', body: '予約フォームと前日の連絡で、触れてほしくないこと・避けたいことを聞かれます。', source: '公式サイト・口コミ12件で確認', ok: true },
        { title: '当日の中断', body: '始まってからでも、合図ひとつで中断できます。追加料金はかかりません。', source: '公式サイトで確認', ok: true },
        { title: 'トラブル時の窓口', body: '店舗の窓口（毎日 12:00〜翌5:00）。Hodokuの相談窓口にも連絡できます。', source: '店舗に電話で確認（10/30）', ok: true },
        { title: '女性スタッフの在籍', body: '受付は男性スタッフのみです。', source: '店舗に電話で確認（10/30）', ok: false },
      ],
      cancel: [
        { label: '前日 23:59 まで', feePercent: 0 }, { label: '当日・3時間前まで', feePercent: 30 },
        { label: '3時間前を過ぎてから', feePercent: 50 }, { label: '連絡なし', feePercent: 100 },
      ],
      therapists: [
        { slug: 'kai', name: 'Kai', bio: '落ち着いた会話と、ゆっくりしたペースが好評です。', texture: 'b' },
        { slug: 'ren', name: 'Ren', bio: 'はじめての方への説明がていねいだという声が多い担当者です。', texture: 'c' },
        { slug: 'itsuki', name: 'Itsuki', bio: '時間配分の相談に柔軟に応じてくれます。', texture: 'a' },
      ],
    },
    {
      slug: 'maison-soie', name: 'Maison Soie', area: '恵比寿駅・出張のみ', station: '恵比寿',
      base: 9900, step: 3500, nomination: 2000, transport: 1500, extension: 6000,
      ng: true, desk: false, freeChangeHours: 3, firstTime: false, lastChecked: '2026-10-21',
      safety: [{ title: 'NGを予約時に確認', body: '予約時に希望を伝えられます。', source: '公式サイトで確認', ok: true }],
      cancel: [{ label: '3時間前まで', feePercent: 0 }, { label: '3時間前を過ぎてから', feePercent: 50 }],
      therapists: [{ slug: 'sora', name: 'Sora', bio: '話しやすい雰囲気で評判です。', texture: 'a' }],
    },
    {
      slug: 'kasumi-room', name: 'Kasumi Room', area: '渋谷駅・ホテル', station: '渋谷',
      base: 12300, step: 4500, nomination: 2000, transport: 1000, extension: 5500,
      ng: true, desk: true, freeChangeHours: 24, firstTime: true, lastChecked: '2026-10-28',
      safety: [{ title: 'NGを事前確認', body: '予約時に確認があります。', source: '公式サイトで確認', ok: true }],
      cancel: [{ label: '前日まで', feePercent: 0 }, { label: '当日', feePercent: 30 }],
      therapists: [{ slug: 'yui', name: 'Yui', bio: '明るい雰囲気で初めての方にも人気です。', texture: 'b' }],
    },
    {
      slug: 'salon-veil', name: 'Salon Veil', area: '代官山駅・ホテルのみ', station: '代官山',
      base: 9400, step: 3800, nomination: 2000, transport: 0, extension: 5000,
      ng: true, desk: true, freeChangeHours: null, firstTime: false, lastChecked: '2026-09-12',
      safety: [{ title: 'NG事前確認', body: '18〜26時の受付で確認できます。', source: '公式サイトで確認', ok: true }],
      cancel: [{ label: '前日まで', feePercent: 0 }, { label: '当日', feePercent: 50 }],
      therapists: [{ slug: 'nozomi', name: 'Nozomi', bio: '丁寧な対応が評価されています。', texture: 'c' }],
    },
  ];

  for (const s of shops) {
    const shopId = randomUUID();
    await db.query(
      `INSERT INTO shops (id,slug,name,area,station,base_price_yen,price_step_yen,nomination_fee_yen,transport_fee_yen,
         extension_fee_yen,has_ng_precheck,has_support_desk,free_change_hours,first_time_friendly,safety_notes,cancel_policy,last_checked_at,is_sample)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true)`,
      [shopId, s.slug, s.name, s.area, s.station, s.base, s.step, s.nomination, s.transport, s.extension,
        s.ng, s.desk, s.freeChangeHours, s.firstTime, JSON.stringify(s.safety), JSON.stringify(s.cancel), s.lastChecked],
    );
    for (const t of s.therapists) {
      await db.query(
        `INSERT INTO therapists (id, shop_id, slug, name, bio, texture) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), shopId, t.slug, t.name, t.bio, t.texture],
      );
    }
  }
}
