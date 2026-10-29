#!/bin/sh
# Container start-up (deployment only; the app itself is unchanged).
# Hosting platforms (e.g. Render "Secret Files") can provide the configuration as a read-only file:
# it is copied to backend/.env so the Credentials screen can still edit a writable copy.
set -e
for secret in /etc/secrets/.env /run/secrets/qucore.env; do
  if [ -f "$secret" ]; then
    cp "$secret" /app/backend/.env
    echo "QuCoRe: configuration loaded from $secret"
    break
  fi
done
[ -f /app/backend/.env ] || cp /app/backend/.env.example /app/backend/.env
mkdir -p "${QUCORE_DATA_DIR:-/app/backend/data}"
# PORT: set by hosting platforms such as Render (default 10000 there); 8000 for docker compose.
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips="*"
