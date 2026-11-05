#!/usr/bin/env bash
# 本番 Docker イメージが実際に PostgreSQL と接続して起動し、/healthz に応答するかを確認する使い捨てスクリプト。
# 使い終わったら自動で後片付けする。Compose は使わず docker run のみ（Compose 未インストールのため）。
set -u

NET=hodoku-test-net
DB=hodoku-db
APP=hodoku-app-test
IMAGE=hodoku-app:local

cleanup() {
  docker rm -f "$DB" "$APP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- reset ---"
cleanup
docker network create "$NET" >/dev/null

echo "--- start postgres ---"
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_USER=hodoku -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=hodoku \
  postgres:16-alpine >/dev/null

echo "--- wait for postgres ready ---"
for i in $(seq 1 30); do
  if docker exec "$DB" pg_isready -U hodoku -d hodoku >/dev/null 2>&1; then
    echo "postgres ready after ${i}s"; break
  fi
  sleep 1
done

echo "--- start app (production) ---"
# SMTP は到達不能なダミー。起動時 verify は失敗しても warn で継続する設計なので起動には影響しない。
docker run -d --name "$APP" --network "$NET" \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 -e PORT=3000 \
  -e DATABASE_URL="postgres://hodoku:testpass@${DB}:5432/hodoku" \
  -e BASE_URL="https://example.com" \
  -e SESSION_SECRET="test-secret-at-least-32-characters-long-xxxx" \
  -e SMTP_HOST="smtp.invalid" -e SMTP_PORT=587 -e MAIL_FROM="Hodoku <no-reply@example.com>" \
  -e TRUST_PROXY=true \
  -p 127.0.0.1:38080:3000 \
  "$IMAGE" >/dev/null

echo "--- wait for /healthz ---"
RESULT="FAIL"
for i in $(seq 1 30); do
  CODE=$(docker exec "$APP" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>r.text().then(t=>{console.log(r.status+' '+t);process.exit(0)})).catch(e=>{console.error(e.message);process.exit(1)})" 2>/dev/null)
  if [ -n "$CODE" ]; then RESULT="$CODE"; break; fi
  sleep 1
done
echo "healthz in-container: ${RESULT}"

echo "--- healthz from host (published port) ---"
curl -fsS http://127.0.0.1:38080/healthz 2>&1 && echo "  <- host OK" || echo "  <- host FAILED"

echo "--- migrations applied (startup log) ---"
docker logs "$APP" 2>&1 | grep -iE "マイグレーション|listen|error|warn|SMTP" | head -20

echo "--- migration table in DB ---"
docker exec "$DB" psql -U hodoku -d hodoku -tc "SELECT name FROM schema_migrations ORDER BY name;" 2>&1

echo "--- users table has TOTP columns ---"
docker exec "$DB" psql -U hodoku -d hodoku -tc "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name LIKE 'totp%' ORDER BY column_name;" 2>&1

echo "=== DONE ==="
