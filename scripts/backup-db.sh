#!/usr/bin/env bash
# PostgreSQL の定期バックアップ（docker compose の db サービスから pg_dump）。
# cron / systemd タイマーから実行する想定。古いバックアップは RETENTION_DAYS で自動削除。
#
# 使い方（例: 毎日 3:30 に実行する crontab）:
#   30 3 * * * cd /path/to/hodoku-app && BACKUP_DIR=/var/backups/hodoku ./scripts/backup-db.sh >> /var/log/hodoku-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_USER="${POSTGRES_USER:-hodoku}"
DB_NAME="${POSTGRES_DB:-hodoku}"

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/hodoku-${TS}.sql.gz"

echo "[$(date -Is)] backup start -> ${OUT}"
# -T で TTY を無効化（cron 実行でも動くように）。gzip で圧縮して保存。
docker compose exec -T db pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$OUT"

# 破損チェック（gzip が正しく閉じているか）
if ! gzip -t "$OUT"; then
  echo "[$(date -Is)] ERROR: backup file is corrupt, removing ${OUT}" >&2
  rm -f "$OUT"
  exit 1
fi

SIZE="$(du -h "$OUT" | cut -f1)"
echo "[$(date -Is)] backup ok (${SIZE})"

# 古いバックアップを削除
find "$BACKUP_DIR" -name 'hodoku-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | sed 's/^/[deleted old] /' || true

echo "[$(date -Is)] backup done. retained files:"
ls -1t "$BACKUP_DIR"/hodoku-*.sql.gz 2>/dev/null | head -5 || true
