import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export class PaymentError extends Error {
  constructor(public code: 'payments_disabled' | 'declined' | 'provider_error', message: string) { super(message); }
}

export interface ChargeRequest {
  buyerId: string; amountYen: number; description: string;
  /** 同じキーでの再送は二重課金にならないこと（実プロバイダの冪等キーに渡す） */
  idempotencyKey: string;
}

/** 決済プロバイダの差し替え口。SUI Credit Service / BitCash 等の審査が通ったら、ここを実装する */
export interface PaymentProvider {
  readonly name: string;
  charge(req: ChargeRequest): Promise<{ ref: string }>;
  refund(ref: string, amountYen: number): Promise<void>;
}

/** 本番の初期状態：購入を受け付けない */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'disabled';
  async charge(): Promise<never> { throw new PaymentError('payments_disabled', '現在、有料口コミの購入は準備中です'); }
  async refund(): Promise<never> { throw new PaymentError('payments_disabled', '決済が無効です'); }
}

/** 開発・テスト用：実際の課金はしない。failNext で失敗を再現できる */
export class StubPaymentProvider implements PaymentProvider {
  readonly name = 'stub';
  readonly charges = new Map<string, { amountYen: number; refunded: boolean }>();
  private seen = new Map<string, string>();
  failNextCharge = false;
  failNextRefund = false;

  async charge(req: ChargeRequest) {
    if (this.failNextCharge) { this.failNextCharge = false; throw new PaymentError('declined', 'カードが承認されませんでした'); }
    const existing = this.seen.get(req.idempotencyKey);
    if (existing) return { ref: existing };
    const ref = `stub_${randomUUID()}`;
    this.charges.set(ref, { amountYen: req.amountYen, refunded: false });
    this.seen.set(req.idempotencyKey, ref);
    return { ref };
  }

  async refund(ref: string, amountYen: number) {
    if (this.failNextRefund) { this.failNextRefund = false; throw new PaymentError('provider_error', '返金処理に失敗しました'); }
    const c = this.charges.get(ref);
    if (!c) throw new PaymentError('provider_error', '対象の決済が見つかりません');
    if (c.refunded) return; // 冪等
    if (amountYen !== c.amountYen) throw new PaymentError('provider_error', '返金額が一致しません');
    c.refunded = true;
  }
}

// ---------------- ポイントチャージ（ビットキャッシュ） ----------------

export interface BeginChargeRequest {
  /** 自サイトのチャージ注文ID（冪等キー兼・Webhook照合に使う） */
  chargeId: string;
  userId: string;
  amountYen: number;
  /** 決済完了後に戻ってくるURL */
  returnUrl: string;
}

/** 決済開始の結果。利用者をこのURL（プロバイダのホスト画面）へリダイレクトする */
export interface BeginChargeResult { redirectUrl: string; providerRef: string }

/** Webフックの検証結果（決済完了通知） */
export interface WebhookResult {
  /** 照合用。beginCharge で渡した chargeId に対応する */
  chargeId: string;
  providerRef: string;
  amountYen: number;
  status: 'completed' | 'failed';
}

/**
 * ビットキャッシュのチャージ決済プロバイダ差し替え口。
 * リダイレクト型（プリペイドID=ひらがな入力はプロバイダのホスト画面で行う）を前提とし、
 * 完了は Webフックで受け取る。実際の署名方式・パラメータは契約する決済代行会社の仕様に合わせて実装する。
 */
export interface PointsPaymentProvider {
  readonly name: string;
  /** チャージ決済を開始し、リダイレクト先URLを返す */
  beginCharge(req: BeginChargeRequest): Promise<BeginChargeResult>;
  /** Webフックの署名検証と内容の取り出し。検証に失敗したら例外 */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<WebhookResult>;
}

/** 本番の初期状態：チャージを受け付けない（決済代行の審査・接続が済むまで） */
export class DisabledPointsProvider implements PointsPaymentProvider {
  readonly name = 'disabled';
  async beginCharge(): Promise<never> { throw new PaymentError('payments_disabled', '現在、ポイントのチャージは準備中です'); }
  async verifyWebhook(): Promise<never> { throw new PaymentError('payments_disabled', 'チャージは無効です'); }
}

/**
 * 開発・テスト用のポイントチャージ。実際の決済はしない。
 * beginCharge は自サイトの確認用URLを返し、completeUrl() で疑似的に完了Webフックを組み立てられる。
 */
export class StubPointsProvider implements PointsPaymentProvider {
  readonly name = 'stub';
  readonly orders = new Map<string, { amountYen: number }>();
  failNextCharge = false;

  async beginCharge(req: BeginChargeRequest): Promise<BeginChargeResult> {
    if (this.failNextCharge) { this.failNextCharge = false; throw new PaymentError('provider_error', 'チャージ開始に失敗しました'); }
    const providerRef = `bcstub_${randomUUID()}`;
    this.orders.set(req.chargeId, { amountYen: req.amountYen });
    // テストでは即時に完了Webフックを送る運用。リダイレクト先は確認ページに戻すだけ。
    return { redirectUrl: `${req.returnUrl}?charge=${encodeURIComponent(req.chargeId)}`, providerRef };
  }

  /** テスト用：完了Webフックのボディを作る（本番は決済代行から届く） */
  completedWebhookBody(chargeId: string, providerRef: string): string {
    const o = this.orders.get(chargeId);
    return JSON.stringify({ chargeId, providerRef, amountYen: o?.amountYen ?? 0, status: 'completed' });
  }

  async verifyWebhook(rawBody: string): Promise<WebhookResult> {
    // スタブは署名検証を省略し、JSONをそのまま信頼する（本番プロバイダでは必ず署名検証する）
    const b = JSON.parse(rawBody) as WebhookResult;
    if (!b.chargeId || !b.providerRef || typeof b.amountYen !== 'number') throw new PaymentError('provider_error', '不正な通知です');
    return { chargeId: b.chargeId, providerRef: b.providerRef, amountYen: b.amountYen, status: b.status === 'completed' ? 'completed' : 'failed' };
  }
}

/**
 * ビットキャッシュ（決済代行会社経由）の本番プロバイダ雛形。
 * Webフックの署名検証（HMAC-SHA256）は汎用的な形で実装済み。
 * ただし beginCharge のリダイレクト連携と、Webフックの実パラメータ名・ヘッダ名・署名方式は
 * 契約する決済代行会社の仕様に合わせて必ず調整すること（下記は代表的な形の仮実装）。
 */
export class BitcashPointsProvider implements PointsPaymentProvider {
  readonly name = 'bitcash';
  constructor(private webhookSecret: string, private apiBase?: string) {}

  async beginCharge(_req: BeginChargeRequest): Promise<BeginChargeResult> {
    // 実際には決済代行会社の「決済セッション作成API」を呼び、返ってきたホスト画面URLへリダイレクトする。
    // 代行会社の API 仕様（エンドポイント・認証・パラメータ）が未確定のため、接続前は明示的に失敗させる。
    throw new PaymentError('provider_error', 'ビットキャッシュ連携は決済代行会社のAPI仕様に合わせて実装してください（beginCharge 未接続）');
  }

  /**
   * Webフックの署名を HMAC-SHA256 で検証する。ヘッダ名・署名対象は代行会社仕様に合わせる。
   * ここでは `x-signature: hex(hmac_sha256(secret, rawBody))` を仮定する。
   */
  async verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<WebhookResult> {
    const sig = headers['x-signature'] ?? headers['x-bitcash-signature'];
    if (!sig) throw new PaymentError('provider_error', '署名がありません');
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new PaymentError('provider_error', '署名が一致しません');
    const body = JSON.parse(rawBody) as Partial<WebhookResult>;
    if (!body.chargeId || !body.providerRef || typeof body.amountYen !== 'number') throw new PaymentError('provider_error', '不正な通知です');
    return { chargeId: body.chargeId, providerRef: body.providerRef, amountYen: body.amountYen, status: body.status === 'completed' ? 'completed' : 'failed' };
  }
}
