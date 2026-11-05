import nodemailer, { type Transporter } from 'nodemailer';

export interface Mail { to: string; subject: string; text: string }

export interface Mailer { send(mail: Mail): Promise<void> }

/** 開発・テスト用：送信せずに保持し、コンソールにも出す */
export class MemoryMailer implements Mailer {
  readonly outbox: Mail[] = [];
  constructor(private readonly log = false) {}
  async send(mail: Mail) {
    this.outbox.push(mail);
    if (this.log) console.log(`[mail] to=${mail.to}\n  subject=${mail.subject}\n${mail.text}\n`);
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** true=465のTLS直結、false=STARTTLS（587等） */
  secure: boolean;
  user?: string;
  pass?: string;
  /** 差出人（例: "Hodoku <no-reply@example.com>"） */
  from: string;
}

/** 本番用：SMTP で実送信する */
export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;
  private readonly from: string;
  constructor(opts: SmtpOptions) {
    this.from = opts.from;
    this.transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      // STARTTLS(587等)のとき、サーバがTLSを提供しなければ送信を中止する（平文送信でリセットリンク等を漏らさない）
      requireTLS: !opts.secure,
      // user/pass が無い場合は認証なし（社内中継等）を許容する
      auth: opts.user ? { user: opts.user, pass: opts.pass ?? '' } : undefined,
    });
  }
  async send(mail: Mail) {
    await this.transporter.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  }
  /** 起動時の接続確認に使う（任意） */
  async verify(): Promise<void> {
    await this.transporter.verify();
  }
}
