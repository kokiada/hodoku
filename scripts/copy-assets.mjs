// tsc は .sql などの非TSアセットを出力しないため、ビルド後に dist へコピーする。
// migrate.ts はコンパイル後ファイルからの相対で migrations/ を探すので、dist/src/db/migrations が必要。
import { cp } from 'node:fs/promises';

const pairs = [
  ['src/db/migrations', 'dist/src/db/migrations'],
];

for (const [from, to] of pairs) {
  await cp(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
