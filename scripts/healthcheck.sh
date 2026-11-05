#!/usr/bin/env bash
# 軽量なヘルス監視。/healthz を叩き、失敗したら非ゼロ終了し、任意で Slack 等の Webhook に通知する。
# cron から数分おきに実行する想定（外部監視サービスが無い最小構成向け）。
#
# 使い方（例: 5分おき）:
#   */5 * * * * HEALTH_URL=https://example.com/healthz ALERT_WEBHOOK=https://hooks.slack.com/... /path/to/hodoku-app/scripts/healthcheck.sh >> /var/log/hodoku-health.log 2>&1
set -u

URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"
WEBHOOK="${ALERT_WEBHOOK:-}"
TIMEOUT="${HEALTH_TIMEOUT:-10}"

notify() {
  local msg="$1"
  echo "[$(date -Is)] ${msg}"
  if [ -n "$WEBHOOK" ]; then
    # Slack 互換の {"text": "..."} 形式で送る。失敗しても監視自体は止めない。
    curl -s -m 10 -X POST -H 'content-type: application/json' \
      -d "{\"text\":\"[Hodoku] ${msg}\"}" "$WEBHOOK" >/dev/null 2>&1 || true
  fi
}

CODE="$(curl -s -o /dev/null -m "$TIMEOUT" -w '%{http_code}' "$URL" 2>/dev/null || echo 000)"
if [ "$CODE" = "200" ]; then
  echo "[$(date -Is)] OK ${URL} -> 200"
  exit 0
fi

notify "health check FAILED: ${URL} -> ${CODE}"
exit 1
