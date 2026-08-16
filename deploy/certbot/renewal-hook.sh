#!/usr/bin/env bash
# Certbot renewal deploy hook — reload nginx so it picks up the new certificate.
# Install to /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh (must be executable).
set -euo pipefail

if command -v nginx >/dev/null 2>&1; then
  nginx -t && systemctl reload nginx
  echo "[certbot-deploy-hook] nginx reloaded with renewed certificate at $(date -Is)"
fi
