import { loadConfig } from '../config.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';

const db = await createDb(loadConfig());
const applied = await migrate(db);
console.log(applied.length ? `適用: ${applied.join(', ')}` : '適用するマイグレーションはありません');
await db.close();
