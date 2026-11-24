#!/usr/bin/env bash
# Nightly backup of the master DB and every tenant DB (one dump per database). Cron on the VPS:
#   15 3 * * * /opt/bms/scripts/backup.sh >> /var/log/bms-backup.log 2>&1
# Copy the backup directory off-site (and keep BMS_SECRETS_KEY safe — tenant DB passwords are encrypted with it).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=${BACKUP_DIR:-/var/backups/bms}
DEST="$ROOT/$(date +%F)"
mkdir -p "$DEST" && chmod 700 "$ROOT" "$DEST"
DBS=$(docker compose exec -T postgres psql -U postgres -At -c "SELECT datname FROM pg_database WHERE datname LIKE 'bms\_%'")
for db in $DBS; do
  docker compose exec -T postgres pg_dump -U postgres -Fc "$db" > "$DEST/$db.dump"
done
docker compose exec -T postgres pg_dumpall -U postgres --globals-only > "$DEST/globals.sql"
chmod 600 "$DEST"/*
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "$(date -Is) backup ok: $DEST"
