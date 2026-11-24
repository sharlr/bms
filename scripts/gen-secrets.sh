#!/usr/bin/env bash
# Prints strong random values for .env  (./scripts/gen-secrets.sh >> .env, then remove the empty duplicates)
set -euo pipefail
echo "POSTGRES_SUPERUSER_PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
echo "BMS_DB_PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
echo "BMS_SECRETS_KEY=$(openssl rand -hex 32)"
