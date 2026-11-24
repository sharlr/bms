#!/usr/bin/env bash
# Creates / resets the platform super-admin. The password is prompted (never in shell history or argv).
set -euo pipefail
cd "$(dirname "$0")/.."
read -rp "Platform admin email: " EMAIL
read -rsp "Password (10+ chars, upper, lower, digit): " PASS; echo
docker compose exec -T -e PLATFORM_ADMIN_EMAIL="$EMAIL" -e PLATFORM_ADMIN_PASSWORD="$PASS" api node dist/scripts/create-platform-admin.js
