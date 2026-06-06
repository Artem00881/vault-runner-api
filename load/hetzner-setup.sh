#!/usr/bin/env bash
#
# Vault Run — Hetzner load-box bootstrap (Phase 4.5c.3 10k SLA run).
#
# ONE script, three roles (pick with the first arg):
#   target     install Docker + bring up the TARGET stack (postgres+redis+api) from this
#              working tree, in TEST env, engine autostart on, /metrics open with a test
#              token, throttle raised. This is the box under test (CCX33 calibration, or a
#              CCX23 cluster node).
#   target-op  same as `target` but boots the API in OPERATOR mode (WALLET_PROVIDER_TYPE=
#              operator + RISK_* ceilings) AND starts the bundled stub operator wallet, then
#              provisions the `load-stub` Operator row pointing at it. For the settlement-SLA
#              worst-case run (ws-load.ts AUTH_MODE=operator).
#   generator  install Bun + the repo deps on a SEPARATE box so it can drive ws-load.ts
#              shards against a target. Does NOT run the API.
#
# Code delivery (works either way — the script auto-detects):
#   git:   git clone <repo> vault-runner-api && cd vault-runner-api && git checkout 6bfda18
#          then: bash load/hetzner-setup.sh target
#   rsync: rsync -az --exclude node_modules --exclude .git ./ root@<box>:/root/vault-runner-api/
#          then on the box: cd /root/vault-runner-api && bash load/hetzner-setup.sh target
#   (if it's a git checkout, `target` will try to `git checkout` $PIN_COMMIT — default
#    6bfda18 — so the measured build matches prod; pass PIN_COMMIT='' to skip / use rsync HEAD.)
#
# Idempotent: re-running is safe (Docker install is skipped if present; compose `up -d`
# reconciles; the operator row is upserted).
#
# ENV overrides (all optional):
#   PIN_COMMIT      (6bfda18)  git ref to check out for a `target` (set '' to keep current tree)
#   BIND_ADDR       (auto)     interface the API port publishes on. Auto-detects the Hetzner
#                              PRIVATE IP (10.x/172.16-31.x/192.168.x) if present, else 0.0.0.0.
#   METRICS_TOKEN   (loadtok)  /metrics bearer (pass the SAME to the generator's harness)
#   JWT_SECRET      (loadtest-jwt-secret)
#   THROTTLE_LIMIT  (10000000) raise so a generator's guest-auth burst isn't 429'd
#   STUB_WALLET_PORT(4001)     (target-op) stub operator wallet port
#   STUB_WALLET_KEY (stub-key) (target-op) stub operator wallet bearer key
#
set -euo pipefail

ROLE="${1:-}"
PIN_COMMIT="${PIN_COMMIT-6bfda18}"
METRICS_TOKEN="${METRICS_TOKEN:-loadtok}"
JWT_SECRET="${JWT_SECRET:-loadtest-jwt-secret}"
GAME_CURRENCY="${GAME_CURRENCY:-DEMO}"
THROTTLE_LIMIT="${THROTTLE_LIMIT:-10000000}"
STUB_WALLET_PORT="${STUB_WALLET_PORT:-4001}"
STUB_WALLET_KEY="${STUB_WALLET_KEY:-stub-key}"

# Resolve the repo root = the dir CONTAINING this script's parent (script is in load/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.loadtest.yml"
ENV_FILE="$SCRIPT_DIR/.env.loadtest"

log() { echo -e "\033[1;36m[setup]\033[0m $*"; }
err() { echo -e "\033[1;31m[setup:ERROR]\033[0m $*" >&2; }

usage() {
  echo "usage: bash load/hetzner-setup.sh {target|target-op|generator}"
  echo "  target     — postgres+redis+api (internal/guest mode) as the box under test"
  echo "  target-op  — target in OPERATOR mode + stub wallet + provisioned operator row"
  echo "  generator  — install Bun + deps to DRIVE ws-load.ts shards (no API)"
  exit 1
}

# --- detect the Hetzner private IP (ens10 / enp7s0 on Cloud), else 0.0.0.0 ---
detect_bind_addr() {
  if [ -n "${BIND_ADDR:-}" ]; then echo "$BIND_ADDR"; return; fi
  local ip
  ip="$(ip -4 -o addr show 2>/dev/null \
    | awk '{print $4}' | cut -d/ -f1 \
    | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)' | head -1 || true)"
  if [ -n "$ip" ]; then echo "$ip"; else echo "0.0.0.0"; fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + compose already present ($(docker --version))"
    return
  fi
  log "installing Docker (official convenience script)…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  log "Docker installed: $(docker --version)"
}

install_bun() {
  if command -v bun >/dev/null 2>&1; then
    log "Bun already present ($(bun --version))"
  else
    log "installing Bun…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y && apt-get install -y curl unzip
    curl -fsSL https://bun.sh/install | bash
    # shellcheck disable=SC1090
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    log "Bun installed: $(bun --version)"
  fi
}

maybe_checkout_pin() {
  if [ -d "$REPO_DIR/.git" ] && [ -n "$PIN_COMMIT" ]; then
    log "git checkout $PIN_COMMIT (so the measured build matches prod)…"
    git -C "$REPO_DIR" fetch --all --tags --quiet || true
    git -C "$REPO_DIR" checkout "$PIN_COMMIT" || err "could not checkout $PIN_COMMIT — measuring the current tree instead"
    log "now at $(git -C "$REPO_DIR" rev-parse --short HEAD)"
  else
    [ -n "$PIN_COMMIT" ] && log "not a git checkout (rsync'd tree?) — measuring the tree as-is"
  fi
}

write_env() {
  local wallet_mode="$1"
  local bind_addr
  bind_addr="$(detect_bind_addr)"
  log "writing $ENV_FILE (BIND_ADDR=$bind_addr wallet=$wallet_mode)"
  cat >"$ENV_FILE" <<EOF
# generated by load/hetzner-setup.sh — load-test target knobs
BIND_ADDR=$bind_addr
METRICS_TOKEN=$METRICS_TOKEN
JWT_SECRET=$JWT_SECRET
GAME_CURRENCY=$GAME_CURRENCY
THROTTLE_LIMIT=$THROTTLE_LIMIT
THROTTLE_TTL_MS=60000
WALLET_PROVIDER_TYPE=$wallet_mode
PG_MAX_CONNECTIONS=300
PG_SHARED_BUFFERS=512MB
EOF
  echo "$bind_addr"
}

bring_up_stack() {
  log "building + starting the target stack (postgres+redis+api)…"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build
  log "waiting for the API /health…"
  local bind_addr probe
  bind_addr="$(grep '^BIND_ADDR=' "$ENV_FILE" | cut -d= -f2)"
  probe="127.0.0.1" # always reachable from the box itself
  for i in $(seq 1 60); do
    if curl -fsS "http://$probe:3001/health" >/dev/null 2>&1; then
      log "API healthy after ${i}s: $(curl -s http://$probe:3001/health)"
      log "reachable from the generator at: http://${bind_addr}:3001  (private IP if detected)"
      log "engine boot:"
      docker logs vaultrun-api 2>&1 | grep -iE "acquired leadership|engine started|listening" | tail -3 || true
      return 0
    fi
    sleep 2
  done
  err "API did not become healthy in 120s — tail:"
  docker logs vaultrun-api 2>&1 | tail -30
  return 1
}

start_stub_and_provision() {
  install_bun
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"; export PATH="$BUN_INSTALL/bin:$PATH"
  ( cd "$REPO_DIR" && bun install --frozen-lockfile )
  log "starting the stub operator wallet on :$STUB_WALLET_PORT…"
  pkill -f "operator-wallet-stub.ts" 2>/dev/null || true
  # The stub binds 0.0.0.0; the API reaches it via the host gateway. From inside the api
  # container, the host is host.docker.internal (added to /etc/hosts via extra_hosts on
  # Linux compose v2) OR the docker bridge gateway. We point walletApiUrl at the bridge
  # gateway IP so the container can reach the host-run stub.
  local gw
  gw="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)"
  nohup env PORT="$STUB_WALLET_PORT" WALLET_KEY="$STUB_WALLET_KEY" START_BALANCE=100000000 \
    bun "$SCRIPT_DIR/operator-wallet-stub.ts" >/tmp/op-wallet-stub.log 2>&1 &
  sleep 2
  log "stub wallet: $(head -1 /tmp/op-wallet-stub.log || true)"
  log "provisioning Operator row 'load-stub' → http://${gw}:${STUB_WALLET_PORT}"
  ( cd "$REPO_DIR" && DATABASE_URL="postgresql://vault:vault@localhost:5432/vaultrun?schema=public" \
      JWT_SECRET="$JWT_SECRET" bun scripts/operator-provision.ts \
      --code load-stub --name "Load Stub" --currencies "$GAME_CURRENCY" \
      --wallet-url "http://${gw}:${STUB_WALLET_PORT}" --wallet-key "$STUB_WALLET_KEY" )
  log "operator mode ready. Drive it from the generator with:"
  echo "    AUTH_MODE=operator OPERATOR_CODE=load-stub OPERATOR_CURRENCY=$GAME_CURRENCY \\"
  echo "    DATABASE_URL=<reach this box's pg> JWT_SECRET=$JWT_SECRET ... bun load/ws-load.ts"
  echo "  (the generator mints launch tokens itself → it needs DATABASE_URL to THIS box's"
  echo "   postgres + the same JWT_SECRET. Expose pg to the generator, or run the op-mode"
  echo "   harness FROM the target box. See load/RUN-10K.md §operator.)"
}

case "$ROLE" in
  target)
    install_docker
    maybe_checkout_pin
    write_env "internal" >/dev/null
    bring_up_stack
    log "TARGET ready (internal/guest mode). Calibrate from a generator box (see load/RUN-10K.md)."
    ;;
  target-op)
    install_docker
    maybe_checkout_pin
    write_env "operator" >/dev/null
    bring_up_stack
    start_stub_and_provision
    log "TARGET ready (OPERATOR mode + stub wallet). Run the settlement-SLA op-mode harness."
    ;;
  generator)
    install_bun
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"; export PATH="$BUN_INSTALL/bin:$PATH"
    log "installing repo deps for the generator…"
    ( cd "$REPO_DIR" && bun install --frozen-lockfile )
    log "GENERATOR ready. Launch N shards against the target (see load/RUN-10K.md):"
    echo "    BASE_URL=http://<TARGET_PRIVATE_IP>:3001 RAMP_TO=4000 RAMP_SECONDS=300 \\"
    echo "    WORKERS=\$(nproc) SCRAPE_METRICS=1 METRICS_TOKEN=$METRICS_TOKEN bun load/ws-load.ts"
    ;;
  *)
    usage
    ;;
esac
