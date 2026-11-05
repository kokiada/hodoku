import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { Config } from '../config.js';

export interface Queryable {
  /** パラメータなしの複数文SQL（マイグレーション用） */
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}

export interface Db extends Queryable {
  /** 全体をひとつのトランザクションで実行。例外ならロールバック */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** 本番：PostgreSQL（pg） */
export function createPgDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    async exec(sql) { await pool.query(sql); },
    async query(sql, params) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q: Queryable = {
          async exec(sql) { await client.query(sql); },
          async query(sql, params) {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        };
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** 開発・テスト：組み込みPostgreSQL（PGlite）。dir を省略するとメモリ上 */
export async function createPgliteDb(dir?: string): Promise<Db> {
  if (dir) mkdirSync(dir, { recursive: true });
  const lite = dir ? new PGlite(dir) : new PGlite();
  await lite.waitReady;
  const wrap = (x: PGlite): Queryable => ({
    async exec(sql: string) { await x.exec(sql); },
    async query<T>(sql: string, params?: unknown[]) {
      const r = await x.query<T>(sql, params);
      return { rows: r.rows, rowCount: Math.max(r.rows.length, r.affectedRows ?? 0) };
    },
  });
  const base = wrap(lite);
  return {
    exec: base.exec,
    query: base.query,
    tx: (fn) => lite.transaction((t) => fn(wrap(t as unknown as PGlite))),
    close: () => lite.close(),
  };
}

export async function createDb(cfg: Config): Promise<Db> {
  if (cfg.DATABASE_URL) return createPgDb(cfg.DATABASE_URL);
  if (cfg.isProd) throw new Error('本番では DATABASE_URL が必要です');
  return createPgliteDb(cfg.NODE_ENV === 'test' ? undefined : cfg.PGLITE_DIR);
}
