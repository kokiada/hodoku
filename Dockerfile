# syntax=docker/dockerfile:1

# --- ビルド段: TypeScript をコンパイルし、本番依存だけを用意する ---
FROM node:22-alpine AS build
WORKDIR /app

# 依存のインストール（キャッシュが効くよう先に manifest だけコピー）
COPY package.json package-lock.json ./
RUN npm ci

# ソースをコピーして本番ビルド（dist/src のみ生成。test は含めない）
# build:prod は tsc 後に migrations/*.sql を dist へコピーする（tsc は非TSアセットを出力しないため）
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build:prod

# 本番用に devDependencies を落とした node_modules を作る
RUN npm prune --omit=dev

# --- 実行段: 最小限のファイルだけを含む軽量イメージ ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 非 root ユーザーで実行する（node イメージ同梱の node ユーザー）
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public

# PGlite のデータ保存先（本番では DATABASE_URL を使うため通常は未使用）
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
# 既定は 127.0.0.1 バインドのため、コンテナ外公開には HOST=0.0.0.0 を渡す
ENV HOST=0.0.0.0

# 簡易ヘルスチェック（/healthz は依存なしで応答する）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
