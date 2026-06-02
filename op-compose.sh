#!/usr/bin/env bash
# op-compose.sh — run the PRODUCTION docker compose stack with secrets injected
# from 1Password at runtime, so no secret is ever written to disk.
#
#   ./op-compose.sh up -d --build     # deploy / redeploy
#   ./op-compose.sh ps                # status
#   ./op-compose.sh logs -f api       # logs
#   ./op-compose.sh config            # validate (with secrets resolved)
#
# How it works: it loads a 1Password service-account token, then runs
#   op run --env-file=op.prod.env -- docker compose -f docker-compose.prod.yml ...
# `op run` resolves the op:// references in op.prod.env to real values and exposes
# them as environment variables to docker compose only for the duration of the
# command (they stay in memory). See DEPLOY.md §12.
#
# Requires: the 1Password CLI (op) installed, and a service-account token readable
# at $OP_TOKEN_FILE (default /etc/vaultrun/op-sa-token) with READ access to the
# "VaultRun-Prod" vault.
set -euo pipefail
cd "$(dirname "$0")"

OP_TOKEN_FILE="${OP_TOKEN_FILE:-/etc/vaultrun/op-sa-token}"
OP_ENV_FILE="${OP_ENV_FILE:-op.prod.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

if ! command -v op >/dev/null 2>&1; then
  echo "ERROR: 1Password CLI (op) is not installed. See DEPLOY.md §12." >&2
  exit 1
fi

if [ ! -r "$OP_TOKEN_FILE" ]; then
  echo "ERROR: 1Password service-account token not readable at $OP_TOKEN_FILE" >&2
  echo "       Place it there (chmod 600) — see DEPLOY.md §12." >&2
  exit 1
fi

export OP_SERVICE_ACCOUNT_TOKEN
OP_SERVICE_ACCOUNT_TOKEN="$(cat "$OP_TOKEN_FILE")"

exec op run --env-file="$OP_ENV_FILE" -- docker compose -f "$COMPOSE_FILE" "$@"
