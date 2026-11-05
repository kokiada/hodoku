#!/usr/bin/env bash
# バックアップから PostgreSQL を復元する。backup-db.sh が作った .sql.gz を渡す。
# 注意: 既存データに上書き適用される。復元前に現状のバックアップを取ること。
#
# 使い方:
#   ./scripts/restore-db.sh ./backups/hodoku-20261105-033000.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:-}"
DB_USER="${POSTGRES_USER:-hodoku}"
DB_NAME="${POSTGRES_DB:-hodoku}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "usage: $0 <backup.sql.gz>" >&2
  exit 1
fi

echo "[$(date -Is)] restoring ${FILE} into ${DB_NAME} ..."
gunzip -c "$FILE" | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME"
echo "[$(date -Is)] restore done"
