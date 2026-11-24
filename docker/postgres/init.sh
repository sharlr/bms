#!/bin/sh
# Runs once on first start of the postgres container (empty volume).
# Creates the application role WITHOUT superuser: it may only create tenant databases and roles.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_user="$BMS_DB_USER" -v app_pass="$BMS_DB_PASSWORD" -v master_db="$BMS_MASTER_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pass' CREATEDB CREATEROLE NOSUPERUSER NOREPLICATION;
CREATE DATABASE :"master_db" OWNER :"app_user" ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE :"master_db" FROM PUBLIC;
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
SQL
