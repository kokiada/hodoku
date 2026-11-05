#!/usr/bin/env bash
# CSP/nonce の動作確認（単一リクエストでヘッダと本文の nonce 一致を確認）。使い捨て。
set -u
cd "$(dirname "$0")/.."

pkill -f "tsx.*src/index.ts" 2>/dev/null || true
sleep 1

PORT=3999 npx tsx src/index.ts > /tmp/hodoku-csp.log 2>&1 &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null; pkill -P "$SRV" 2>/dev/null; pkill -f "tsx.*src/index.ts" 2>/dev/null; }
trap cleanup EXIT

for i in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:3999/healthz" && break
  sleep 1
done

HDRFILE=$(mktemp)
BODY=$(curl -s -D "$HDRFILE" "http://127.0.0.1:3999/age")

echo "=== CSP directives ==="
grep -io "content-security-policy:.*" "$HDRFILE" | tr ';' '\n' | grep -iE "script-src |style-src |object-src|base-uri|frame-src|script-src-attr" | sed 's/^ */  /'

HN=$(grep -io "script-src [^;]*" "$HDRFILE" | grep -o "nonce-[A-Za-z0-9+/=_-]*" | head -1)
BN=$(printf '%s' "$BODY" | grep -o 'nonce="[^"]*"' | head -1 | sed 's/nonce="//;s/"//')

echo "=== inline <script> tags in body ==="
printf '%s' "$BODY" | grep -o "<script[^>]*>" | sed 's/^/  /'

echo "=== nonce comparison (same request) ==="
echo "  header: $HN"
echo "  body:   nonce-$BN"
if [ -n "$HN" ] && [ -n "$BN" ] && [ "nonce-$BN" = "$HN" ]; then
  echo "  RESULT: MATCH (inline script will be allowed by CSP)"
else
  echo "  RESULT: MISMATCH (inline script would be BLOCKED)"
fi

echo "=== unsafe-inline in script-src? ==="
grep -io "script-src [^;]*" "$HDRFILE" | grep -q "unsafe-inline" && echo "  present (bad)" || echo "  absent (good)"

rm -f "$HDRFILE"
echo "=== DONE ==="
