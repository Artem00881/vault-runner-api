#!/usr/bin/env bash
# op-compose.staging.sh — deploy/operate the STAGING stack.
#
# Identical to op-compose.sh, but injects secrets from the **VaultRun-Staging**
# 1Password vault (op.staging.env) instead of prod. It reuses
# docker-compose.prod.yml unchanged — the stack shape is the same; the only
# difference between prod and staging is which vault the secrets come from.
#
#   ./op-compose.staging.sh up -d --build     # deploy / redeploy
#   ./op-compose.staging.sh ps                # status
#   ./op-compose.staging.sh logs -f api       # logs
#
# Requires: op CLI installed, and a service-account token at
# /etc/vaultrun/op-sa-token (chmod 600) with READ access to VaultRun-Staging.
# See DEPLOY.md §12.
exec env OP_ENV_FILE=op.staging.env "$(dirname "$0")/op-compose.sh" "$@"
