import { randomUUID } from 'node:crypto';
import type { Queryable } from './index.js';
import { hashPassword } from '../lib/crypto.js';

export const DEMO_PASSWORD = 'demo-password-1';

export const DEMO_ACCOUNTS = [
  { email: 'admin@example.com', nickname: 'admin', role: 'admin' as const, note: '管理者（管理画面・出金の承認）' },
  { email: 'mod@example.com', nickname: 'moderator', role: 'moderator' as const, note: 'モデレーター（投稿審査・返金）' },
  { email: 'writer@example.com', nickname: 'writer', role: 'user' as const, note: '一般ユーザー（有料口コミを出品している人）' },
  { email: 'reader@example.com', nickname: 'reader', role: 'user' as const, note: '一般ユーザー（買う側）' },
];

/**
 * 開発用デモデータ。既知のパスワードのアカウントを作るため、本番では呼び出し側で必ず止めること。
 * ユーザーが1人でもいれば何もしない（既存データを壊さない）。
 */
export async function seedDemo(db: Queryable): Promise<boolean> {
  if ((await db.query('SELECT 1 FROM users LIMIT 1')).rowCount > 0) return false;

  const hash = await hashPassword(DEMO_PASSWORD);
  const ids: Record<string, string> = {};
  for (const a of DEMO_ACCOUNTS) {
    const id = randomUUID();
    ids[a.nickname] = id;
    await db.query(
      `INSERT INTO users (id,email,nickname,password_hash,role,email_verified_at) VALUES ($1,$2,$3,$4,$5,now())`,
      [id, a.email, a.nickname, hash, a.role],
    );
  }
  // 口コミの「投稿者」らしさを出すための一般ユーザー
  const extra = ['yuzu', 'mio', 'suzu', 'miro'];
  for (const n of extra) {
    const id = randomUUID(); ids[n] = id;
    await db.query(`INSERT INTO users (id,email,nickname,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now())`, [id, `${n}@example.com`, n, hash]);
  }

  const th = async (slug: string) => (await db.query<{ id: string }>('SELECT id FROM therapists WHERE slug=$1', [slug])).rows[0]!.id;
  const kai = await th('kai');

  const add = async (o: { author: string; therapist: string; body: string; kind?: 'free' | 'paid'; price?: number; verified?: boolean; gift?: boolean;
    when?: string; minutes?: number; ng?: string; total?: string; scores?: [number, number, number]; flags?: string[]; helpful?: number; status?: string; daysAgo?: number }) => {
    const s = o.scores ?? [5, 5, 5];
    await db.query(
      `INSERT INTO reviews (id,author_id,therapist_id,visited_when,course_minutes,ng_precheck,total_matched,score_care,score_comfort,score_punctual,
         gift_received,body,listing_kind,price_yen,usage_verified,status,auto_flags,helpful_count,published_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now() - ($19 || ' days')::interval, now() - ($19 || ' days')::interval)`,
      [randomUUID(), ids[o.author], o.therapist, o.when ?? 'this_month', o.minutes ?? 90, o.ng ?? 'on_booking', o.total ?? 'matched', s[0], s[1], s[2],
        o.gift ?? false, o.body, o.kind ?? 'free', o.kind === 'paid' ? (o.price ?? 300) : null, o.verified ?? true, o.status ?? 'published',
        JSON.stringify(o.flags ?? []), o.helpful ?? 0, String(o.daysAgo ?? 3)],
    );
  };

  await add({ author: 'yuzu', therapist: kai, helpful: 12, daysAgo: 4, scores: [5, 5, 5],
    body: '予約のときに苦手なことを丁寧に聞いてもらえて、当日は緊張が少しずつほどけました。総額も事前の案内どおりで、帰り道まで落ち着いた気持ちでした。' });
  await add({ author: 'miro', therapist: kai, kind: 'paid', price: 300, minutes: 120, helpful: 6, daysAgo: 6, scores: [5, 4, 5],
    body: '何度かお願いしていて、回ごとの違いも含めて細かく書きます。はじめの日は緊張していたのですが、最初に流れをひととおり説明してくれました。時間配分も相談しながら決められ、終わったあとまで落ち着いて過ごせました。二回目以降は好みを覚えていてくれて、予約のやり取りもスムーズでした。総額は毎回、事前の案内どおりでした。' });
  await add({ author: 'suzu', therapist: kai, kind: 'paid', price: 200, helpful: 8, daysAgo: 9, scores: [4, 5, 5],
    body: 'はじめての利用で不安が大きかったので、予約から当日までの流れを時系列で残しておきます。メールでのやり取りはていねいで、こちらの質問にもその日のうちに返事が来ました。当日は入り口で迷わないよう案内があり、終わったあとの連絡まで落ち着いて過ごせました。気になった点は、延長の案内が少し遅かったことくらいです。' });
  await add({ author: 'mio', therapist: kai, verified: false, gift: true, total: 'slightly_off', minutes: 120, helpful: 4, daysAgo: 11, scores: [4, 4, 4],
    body: '会話のテンポが心地よく、時間どおりに終わる安心感がありました。' });
  await add({ author: 'yuzu', therapist: await th('ren'), verified: true, helpful: 2, daysAgo: 15, scores: [4, 5, 4],
    body: '説明がていねいで、はじめてでも落ち着いて過ごせました。' });

  // 審査キューに並ぶ投稿（モデレーターのデモ用）
  await add({ author: 'reader', therapist: await th('itsuki'), status: 'pending', verified: false, daysAgo: 0,
    body: '時間配分の相談に柔軟に応じてくれました。次回もお願いしたいです。' });

  return true;
}
