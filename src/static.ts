import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { hasAgeConfirmed } from './auth/age-gate.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** 年齢確認なしで開けるページ（ゲート自体・法的表示・確認系） */
const OPEN_PAGES = new Set(['age.html', 'legal.html', 'verify.html', 'reset-password.html', 'login.html']);
/** 検索エンジンに載せないページ */
const NOINDEX = new Set(['admin.html', 'account.html', 'age.html', 'verify.html', 'reset-password.html', 'login.html']);

/** /shops → shops.html のようなクリーンURLに対応 */
function toFile(pathname: string): string {
  if (pathname === '/') return 'index.html';
  const p = decodeURIComponent(pathname).replace(/^\/+/, '');
  return extname(p) ? p : `${p}.html`;
}

export async function registerStatic(app: FastifyInstance, publicDir: string): Promise<void> {
  const root = resolve(publicDir);
  const { config } = app.deps;

  app.get('/robots.txt', async (_req, reply) => {
    reply.type('text/plain; charset=utf-8');
    return 'User-agent: *\nDisallow: /api/\nDisallow: /admin\nDisallow: /account\nDisallow: /age\n';
  });

  app.get('/favicon.ico', async (_req, reply) => reply.redirect('/favicon.svg', 301));

  app.get('/*', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? '/';
    let rel: string;
    try {
      rel = toFile(pathname);
    } catch {
      return reply.code(400).send('Bad Request');
    }
    if (rel.includes('\0') || rel.startsWith('.') || rel.includes('/.')) return reply.code(404).type('text/plain').send('Not Found');

    const abs = resolve(join(root, rel));
    // パストラバーサル対策：公開ディレクトリの外には出さない
    if (abs !== root && !abs.startsWith(root + sep)) return reply.code(404).type('text/plain').send('Not Found');

    const ext = extname(abs);
    const type = TYPES[ext];
    if (!type) return reply.code(404).type('text/plain').send('Not Found');

    let info;
    try { info = await stat(abs); } catch { return reply.code(404).type('text/plain').send('Not Found'); }
    if (!info.isFile()) return reply.code(404).type('text/plain').send('Not Found');

    const isHtml = ext === '.html';
    if (isHtml) {
      const name = rel.split('/').pop() ?? rel;
      if (!OPEN_PAGES.has(name) && !hasAgeConfirmed(req, config.sessionSecret)) {
        const next = encodeURIComponent(req.url);
        return reply.redirect(`/age?next=${next}`, 302);
      }
      reply.header('Cache-Control', 'no-store');
      if (NOINDEX.has(name)) reply.header('X-Robots-Tag', 'noindex, nofollow');
      reply.type(type);
      // CSP: インラインの <script> に per-request の nonce を付与する（script-src から 'unsafe-inline' を外しているため）
      const nonce = reply.cspNonce?.script;
      const html = await readFile(abs, 'utf8');
      return nonce ? html.replaceAll('<script>', `<script nonce="${nonce}">`) : html;
    }
    reply.header('Cache-Control', 'public, max-age=3600');
    reply.type(type);
    return readFile(abs);
  });
}
