#!/bin/sh
set -eu
# Entrypoint init runs only for a NEW PostgreSQL volume. No secret is printed.
export MIGRATOR_PASSWORD="$(cat /run/secrets/migrator_password)"
export APP_PASSWORD="$(cat /run/secrets/app_password)"
export AUTH_PASSWORD="$(cat /run/secrets/auth_password)"
export OPERATOR_PASSWORD="$(cat /run/secrets/operator_password)"
psql -X --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --file /host-release/roles.sql
