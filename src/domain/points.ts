// 風マネーポイント（ビットキャッシュ・チャージ）の定義。純粋データ・純粋関数のみ。
// チャージ時のレートはここで一元管理し、サーバーが金額と付与ポイントを決める（クライアントは選ぶだけ）。

export interface ChargePack {
  /** 支払うビットキャッシュ額（円） */
  yen: number;
  /** 付与される風マネーポイント */
  points: number;
  /** 画面で「おすすめ」バッジを付ける */
  recommended?: boolean;
  /** 基本付与分に対する上乗せ（表示用。points には含まれている） */
  bonus?: number;
}

/**
 * チャージパック一覧（画面の並び順）。
 * 小口は手数料・最低決済額を吸収するため割安レート、1万円以上はボーナスで実質レートが上がる。
 */
export const CHARGE_PACKS: readonly ChargePack[] = [
  { yen: 500, points: 400 },
  { yen: 1000, points: 900 },
  { yen: 2000, points: 1800 },
  { yen: 3000, points: 2800 },
  { yen: 5000, points: 4800 },
  { yen: 10000, points: 10100, recommended: true, bonus: 100 },
  { yen: 20000, points: 20500, bonus: 500 },
  { yen: 30000, points: 31000, bonus: 1000 },
  { yen: 50000, points: 51500, bonus: 1500 },
  { yen: 97000, points: 100000, bonus: 3000 },
] as const;

/** 支払額（円）から正規のパックを引く。無ければ null（クライアントが勝手な額を送れないようにする） */
export function findPack(yen: number): ChargePack | null {
  return CHARGE_PACKS.find((p) => p.yen === yen) ?? null;
}

/** 既定で選択状態にするパック（画面の初期選択） */
export const DEFAULT_PACK_YEN = 2000;
