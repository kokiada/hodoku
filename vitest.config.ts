import { defineConfig } from 'vitest/config';

// PGlite はコールドスタート（wasm 初期化）で初回が遅く、既定の 10 秒では
// beforeAll がタイムアウトすることがある。フック/テストのタイムアウトを引き上げて
// ローカル・CI どちらでも安定して走るようにする。
export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
