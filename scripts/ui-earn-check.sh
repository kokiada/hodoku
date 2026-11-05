#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
pkill -f "tsx.*src/index.ts" 2>/dev/null || true; sleep 1
PORT=3993 npx tsx src/index.ts > /tmp/earn.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null; pkill -P "$SRV" 2>/dev/null; pkill -f "tsx.*src/index.ts" 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:3993/healthz" && break; sleep 1; done
J=/tmp/ej; curl -s -c $J -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:3993/api/auth/age-confirm >/dev/null 2>&1
echo "=== / 稼げる訴求 ==="; curl -s -b $J http://127.0.0.1:3993/ | grep -o "書いて、稼げる\|販売価格の90%" | sort -u
echo "=== /review slug無し: 担当者ピッカー ==="; curl -s -b $J http://127.0.0.1:3993/review | grep -o "口コミを書く担当者をえらんでください\|id=\"picker\"" | sort -u
echo "=== /review?slug=kai: 稼げるnote ==="; curl -s -b $J "http://127.0.0.1:3993/review?slug=kai" | grep -o "読まれるたびに" | head -1
echo "=== ナビに口コミを書く ==="; curl -s -b $J http://127.0.0.1:3993/ | grep -o '>口コミを書く<' | head -1
echo "=== /api/therapists 動作 ==="; curl -s http://127.0.0.1:3993/api/therapists | grep -o '"slug"' | wc -l
echo "=== DONE ==="
