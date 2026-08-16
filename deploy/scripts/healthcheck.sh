#!/usr/bin/env bash
# Token Monitor Hub health check — local loopback probe (no TLS).
# Exit 0 when healthy, 1 otherwise. Run from cron / monitoring (e.g. Uptime Kuma
# using an SSH command, or a simple systemd timer) or manually.
set -euo pipefail

HUB_URL="${TOKEN_MONITOR_HEALTH_URL:-http://127.0.0.1:17321/api/health}"
TIMEOUT_SECS="${TOKEN_MONITOR_HEALTH_TIMEOUT:-5}"

response="$(curl -fsS --max-time "$TIMEOUT_SECS" "$HUB_URL" 2>/dev/null)" || {
  echo "FAIL: hub unreachable at $HUB_URL" >&2
  exit 1
}

if ! printf '%s' "$response" | grep -q '"ok": *true'; then
  echo "FAIL: hub did not report ok: $response" >&2
  exit 1
fi

echo "OK: hub healthy at $HUB_URL"
