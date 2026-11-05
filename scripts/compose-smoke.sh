#!/usr/bin/env bash
# docker compose でスタックを起動し /healthz を確認する使い捨てスクリプト。
# 本番構成（app + PostgreSQL）を Compose 経由で通す検証。終了時に後片付けする。
set -u
cd "$(dirname "$0")/.."

down() { docker compose down -v >/dev/null 2>&1 || true; }

echo "--- clean start ---"
down

echo "--- build + up (detached) ---"
docker compose up -d --build
echo "up exit: $?"

echo "--- container status ---"
docker compose ps

echo "--- wait for app /healthz (host port 3000) ---"
RESULT="FAIL"
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    RESULT=$(curl -fsS http://127.0.0.1:3000/healthz); echo "healthz OK after ${i}s: ${RESULT}"; break
  fi
  sleep 1
done
[ "$RESULT" = "FAIL" ] && echo "healthz never responded"

echo "--- app startup log (migrations / listen / warnings) ---"
docker compose logs app 2>&1 | grep -iE "マイグレーション|listen|warn|SMTP|error" | head -20

echo "--- a couple of real requests ---"
echo -n "GET / (age gate redirect expected): "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/
echo -n "GET /api/shops (should be 200 json): "; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/shops

echo "--- tearing down ---"
down
echo "=== DONE ==="
