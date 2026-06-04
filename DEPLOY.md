# Deploying Vault Run API to a Vultr VPS

This brings the whole backend (API + PostgreSQL + Redis) online with one command.
Tested locally with the exact same Docker setup.

> **You create the VPS yourself** — it uses your Vultr account. The steps below
> are everything after that.

---

## 1. Create the VPS

In the Vultr dashboard:
- **Deploy New Server** → **Cloud Compute**.
- OS: **Ubuntu 24.04 LTS**.
- Size: smallest is fine to start — **1 vCPU / 2 GB RAM** (≈$10–12/mo). 2 GB is
  recommended so Postgres + Redis + the API + the build are comfortable.
- Add your SSH key (or use the password Vultr emails you).
- Deploy. Note the server's **public IP**.

(Optional but recommended) Point a domain/subdomain at the IP, e.g. an A record
`api.yourdomain.com → <IP>`. Needed for HTTPS in step 6.

---

## 2. Connect and install Docker

SSH in:
```bash
ssh root@<YOUR_VPS_IP>
```

Install Docker + compose plugin:
```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

---

## 3. Get the code onto the server

The repo is private, so clone it with a GitHub token (a fine-grained PAT with
read access works), or upload the folder with `scp`.

```bash
git clone https://github.com/Artem00881/vault-runner-api.git
cd vault-runner-api
```
(When asked for a password, paste a GitHub Personal Access Token, not your login
password.)

---

## 4. Configure secrets

Production secrets (`POSTGRES_PASSWORD`, `JWT_SECRET`, `SENTRY_DSN`) are **not**
kept in a `.env` file on the server — they live in **1Password** and are injected
at deploy time. See **§12 Secrets management (1Password)** for the one-time setup.

Non-secret config (`CORS_ORIGIN`, `GAME_CURRENCY`, `POSTGRES_USER/DB`,
`WALLET_PROVIDER_TYPE`) has safe production defaults baked into
`docker-compose.prod.yml`; override only if you need to.

---

## 5. Launch

Deploy through the **`op-compose.sh`** wrapper so secrets are injected from
1Password (see §12). Do **not** call `docker compose -f docker-compose.prod.yml …`
directly in prod — it will fail the `:?` guard with "POSTGRES_PASSWORD not set".

```bash
./op-compose.sh up -d --build
```
This builds the API image, starts Postgres + Redis, runs database migrations
automatically, and starts the server on port **3001**.

Check it:
```bash
./op-compose.sh ps                  # all "Up", postgres healthy
curl http://localhost:3001/health   # {"status":"ok",...}
docker logs vaultrun-api --tail 20  # "Game engine started"
```

Enable the firewall — **SSH only** (the app must NOT be exposed publicly):
```bash
ufw allow 22 && ufw --force enable
```
> ⚠️ Do **not** `ufw allow 3001`/`80`. In production the app binds to
> `127.0.0.1:3001` (see `docker-compose.prod.yml`) and is reached only through a
> Caddy reverse proxy behind Cloudflare. See **§8 Production security hardening**.
> (Docker publishes ports via its own iptables rules that bypass ufw — the real
> protection is the loopback bind, not a ufw rule.)

Useful later:
```bash
./op-compose.sh logs -f api         # live logs
./op-compose.sh up -d --build       # redeploy after git pull
./op-compose.sh down                # stop (keeps data)
docker restart vaultrun-api         # plain restart (no compose re-eval, no op needed)
```

---

## 6. HTTPS + edge

`api.vaultrun.app` is proxied through **Cloudflare** (orange-cloud). Visitors↔
Cloudflare is HTTPS via Cloudflare's edge cert. The Cloudflare↔origin leg and the
origin firewall are hardened in **§8** below — that is the source of truth for the
live networking setup. (An earlier version of this doc terminated TLS with a
Caddy + Let's Encrypt cert and left port 3001 open; that is superseded by §8.)

---

## 7. Point the web app at the backend

In the web app (`vault-runner-main`) set two env vars so it uses the live backend
instead of the local demo:
```
VITE_GAME_MODE=remote
VITE_API_URL=https://api.yourdomain.com    # or http://<IP>:3001 for quick HTTP testing
```
- For the **Lovable-hosted** app: add these in Lovable's project environment
  variables, then republish.
- For a **local** test: put them in `vault-runner-main/.env.local` and run the
  web app locally (works with plain `http://<IP>:3001` too, since a local
  http page can call an http API).

That's it — the deployed web app now plays against the live, server-authoritative
backend.

---

## 8. Production security hardening (live setup)

The origin is **never reachable directly** — only Cloudflare can connect, over an
encrypted, mutually-authenticated channel. Built 2026-06-01.

**Edge → origin path:** visitor → Cloudflare (proxied) → **Caddy on origin :443**
(host process, TLS via a Cloudflare **Origin Certificate**) → `127.0.0.1:3001`
(the Docker app, loopback-only).

**Cloudflare dashboard (zone `vaultrun.app`):**
- SSL/TLS → Overview → **Full (strict)** (was Flexible/cleartext).
- SSL/TLS → Edge Certificates → **Always Use HTTPS = On**.
- SSL/TLS → Origin Server → **Authenticated Origin Pulls → Zone-level = On**, with
  a **custom client certificate uploaded** (our own CA→leaf, see below). Cloudflare
  presents this leaf to the origin; Caddy requires+verifies it. (Global AOP — the
  shared CF cert — is intentionally NOT used; per-zone custom cert is stronger.)

**Origin TLS material** (`/etc/caddy/tls/`, all owned so Caddy can read the `.crt`s):
- `origin.crt` / `origin.key` — Cloudflare **Origin Certificate** (server cert, 15y).
- `cf-ca.crt` / `cf-ca.key` — our private CA (trust anchor for client-cert mTLS).
- `cf-client.crt` / `cf-client.key` — leaf signed by `cf-ca`; this **leaf+key was
  uploaded to Cloudflare** (Zone-level AOP). Caddy trusts `cf-ca.crt`.

**`/etc/caddy/Caddyfile`:**
```caddyfile
{
    auto_https disable_redirects
}
https://api.vaultrun.app {
    tls /etc/caddy/tls/origin.crt /etc/caddy/tls/origin.key {
        client_auth {
            mode require_and_verify
            trust_pool file /etc/caddy/tls/cf-ca.crt
        }
    }
    reverse_proxy 127.0.0.1:3001
}
```

**Firewall (ufw):** only `22` (SSH) and `443` **from Cloudflare IP ranges**. A
weekly systemd timer keeps the CF allowlist current, fail-safe (skips on a bad
fetch so it can never lock CF out):
- `/usr/local/bin/cf-ufw-allow.sh` (add-only, idempotent; fetches cloudflare.com/ips-v4/v6)
- `cf-ufw-allow.service` (oneshot) + `cf-ufw-allow.timer` (`OnCalendar=weekly`).

**App exposure:** `docker-compose.prod.yml` publishes the API on `127.0.0.1:3001`
only — **never** `0.0.0.0`. (Docker's published ports bypass ufw, so the loopback
bind — not a firewall rule — is what keeps the app private.)

**SSH:** key-only. `/etc/ssh/sshd_config.d/00-hardening.conf` (sorts before the
cloud-init drop-in): `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
`PermitRootLogin prohibit-password`. Log in with the key (`ssh -i <key> root@IP`).
Vultr **View Console** is the out-of-band fallback.

**Verify (from any non-Cloudflare host):** `https://api.vaultrun.app/health` → 200;
direct `http://<IP>:3001`, `:80`, and `https://<IP>:443` all time out (blocked).
A TLS connection to origin :443 without the client cert is refused
(`tlsv13 alert certificate required`).

**Rollback levers:** Cloudflare SSL mode → Flexible (instant); restore
`/etc/caddy/Caddyfile.bak*` + `systemctl reload caddy`; `docker-compose.prod.yml.bak`.

---

## 9. Backups (encrypted, off-site) — built 2026-06-01

Automated, **client-side-encrypted**, **off-site** PostgreSQL backups with a
**tested restore**. (These are frequent encrypted snapshots, RPO = 6 h. True
continuous PITR via WAL archiving is a planned real-money-stage upgrade — it
needs `archive_command` on the live DB + archive monitoring.)

**Pipeline** (`/usr/local/bin/vaultrun-backup.sh`, run by `vaultrun-backup.timer`,
`OnCalendar=*-*-* 00/6:00:00`): `docker exec … pg_dump -Fc` (custom/compressed) →
`age -R <pubkey>` (encrypt) → `rclone copy` → **Cloudflare R2** bucket
`vaultrun-backups/db/`, then `rclone delete --min-age 30d` (retention).

**Encryption (age):**
- `/etc/vaultrun/backup-age-pub.txt` — public key, used by the script to encrypt.
- `/etc/vaultrun/backup-age-key.txt` — **private key** (chmod 600). A copy is also
  stored **off-server in 1Password** (+ a 2nd independent copy). **Restoring needs
  this private key** — without it, backups are unrecoverable.

**Off-site store (Cloudflare R2):** rclone remote `r2`
(`/root/.config/rclone/rclone.conf`, chmod 600) → endpoint
`https://<account_id>.r2.cloudflarestorage.com`, bucket `vaultrun-backups`,
auth = an R2 API token (Object Read & Write). R2 free tier covers it (zero egress).
**Use the official rclone build (v1.74+)** — the apt 1.60 emits spurious
`501 NotImplemented` on R2 uploads (`curl https://rclone.org/install.sh | bash`).

**Restore procedure (verified):**
```bash
mkdir -p /tmp/restore
LATEST=$(rclone lsf r2:vaultrun-backups/db/ | sort | tail -1)
rclone copy "r2:vaultrun-backups/db/$LATEST" /tmp/restore/
age -d -i /etc/vaultrun/backup-age-key.txt "/tmp/restore/$LATEST" > /tmp/restore/db.dump
# into a SCRATCH db (never the live one) to verify, or into the real db for DR:
docker exec vaultrun-postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" createdb -U "$POSTGRES_USER" -h 127.0.0.1 vaultrun_restore'
docker exec -i vaultrun-postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$POSTGRES_USER" -h 127.0.0.1 -d vaultrun_restore' < /tmp/restore/db.dump
```

**Dead-man's-switch:** on every success the script also writes a Prometheus
textfile metric for node-exporter (§10):
```bash
printf 'vaultrun_backup_last_success_timestamp_seconds %s\n' "$(date +%s)" \
  > /etc/vaultrun/node-textfile/vaultrun_backup.prom.tmp \
  && mv /etc/vaultrun/node-textfile/vaultrun_backup.prom.tmp \
        /etc/vaultrun/node-textfile/vaultrun_backup.prom
```
If backups silently stop, the `BackupStale` alert fires (§10).

---

## 10. Monitoring (Prometheus + Grafana) — built 2026-06-02

Self-hosted, **bound to localhost** (never public — reached via SSH tunnel).
Config lives in the repo under `monitoring/` (infrastructure-as-code), so it's
versioned + reproducible.

```
App (/metrics, loopback) ──► Prometheus (scrape+store) ──► Grafana (dashboards+alerts)
node-exporter (CPU/RAM/disk + backup textfile) ──┘
```

**Repo files (`monitoring/`):**
- `docker-compose.yml` — Prometheus (`:9090`), node-exporter, Grafana (`:3000`,
  added in G-2). Project name `vaultrun-monitoring`. All host-ports bound to
  `127.0.0.1`. Joins the API's external network `vault-runner-api_default` so
  Prometheus can scrape `vaultrun-api:3001/metrics` internally (the API is
  loopback-only, never scraped over the internet).
- `prometheus/prometheus.yml` — scrape jobs: `vaultrun-api` (`/metrics`), `node`
  (node-exporter), `prometheus`. 15s interval, 15d retention.
- `grafana/provisioning/datasources/datasource.yml` — auto-wires the Prometheus
  datasource (uid `prometheus`).
- `grafana/provisioning/dashboards/dashboards.yml` + `grafana/dashboards/vaultrun.json`
  — the provisioned **"VaultRun — Overview"** dashboard (realized RTP vs 97%,
  throughput, stake/payout, rejections, errors, WS, settlement latency, host CPU/RAM).
- `.env` (gitignored) — Grafana admin user/password (`GF_SECURITY_ADMIN_*`); copy
  from `.env.example`.

**Deploy (on the VPS):**
```bash
cd ~/vault-runner-api && git pull
mkdir -p /etc/vaultrun/node-textfile          # backup dead-man's-switch dir (G-3)
cp -n monitoring/.env.example monitoring/.env && nano monitoring/.env   # set GF_SECURITY_ADMIN_PASSWORD
docker compose -f monitoring/docker-compose.yml up -d
```
Grafana login: open the tunnelled `http://localhost:3000`, user/password from
`monitoring/.env`. The datasource + "VaultRun — Overview" dashboard auto-load.

**Access (from your Mac — nothing is public):**
```bash
ssh -L 9090:127.0.0.1:9090 -L 3000:127.0.0.1:3000 root@95.179.241.145
# then: http://localhost:9090 (Prometheus)  http://localhost:3000 (Grafana)
```

**Verify / debug:**
```bash
docker compose -f monitoring/docker-compose.yml ps
# targets must be UP:
curl -s 'http://127.0.0.1:9090/api/v1/targets' | grep -o '"health":"[a-z]*"' | sort | uniq -c
docker logs vaultrun-prometheus --tail 30
```
If `vaultrun-api` target is DOWN: the network name changed (`docker inspect
vaultrun-api -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'`) —
update `networks.app.name` in `monitoring/docker-compose.yml`.

**Alerting (G-3): Prometheus rules → Alertmanager → Telegram.**
- `prometheus/alerts.yml` — rules: `BackupStale` (no backup metric fresh <7h),
  `BackupMetricMissing`, `ApiDown`, `EngineStalled` (no rounds 15m — e.g. fairness
  chain exhausted), `ErrorSpike`, `HostDiskLow`, `HostMemoryHigh`, `PayoutsPending`
  (`vaultrun_pending_payouts > 0` for 15m), `PayoutStuck`
  (`vaultrun_pending_payout_oldest_seconds > 3600`).
- `alertmanager/alertmanager.yml` (gitignored; copy from `.yml.example`) — routes
  to a Telegram bot. The dead-man's-switch metric is written by the backup script
  (§9) into `/etc/vaultrun/node-textfile/` and exposed by node-exporter.
- **After editing `alerts.yml`** (adding/changing a rule — e.g. `PayoutsPending`/
  `PayoutStuck`) you must reload the rules on the monitoring host for them to take
  effect: `git pull` on the VPS, then **restart the Prometheus container**:
  `docker compose -f monitoring/docker-compose.yml restart prometheus`. Confirm the
  rule is live: `curl -s http://127.0.0.1:9090/api/v1/rules | grep PayoutStuck`.
  **OPS GOTCHA (verified on prod 2026-06-03):** the hot-reload endpoint
  `curl -X POST http://127.0.0.1:9090/-/reload` returns **HTTP 403** here — our
  Prometheus is **NOT** started with `--web.enable-lifecycle`, so `/-/reload` is
  disabled. Use the `restart prometheus` command above instead (do NOT rely on
  `/-/reload`). The metrics those rules read ship with the normal backend deploy.

**`/metrics` + `/health` auth (audit H5) — ACTIVATION (coordinated deploy).**
The app code ships with a guard that is **OPEN when `METRICS_TOKEN` is unset** (no
behaviour change until activated). To actually LOCK `/metrics` (bearer-only) and
slim the public `/health` to `{status}` only, do this **in order** — getting the
order wrong breaks either the whole API stack or monitoring:
1. **Create the secret FIRST.** In 1Password vault `VaultRun-Prod` create a
   `METRICS_TOKEN` item (password field), value with NO trailing newline:
   `openssl rand -hex 32`. (Same in `VaultRun-Staging` before locking staging.)
   The `op://` ref (step 3) makes `op run` resolve it on EVERY deploy — if the item
   is missing, `./op-compose.sh up` fails the **entire** stack (fail-closed). So the
   item must exist before the ref is committed/deployed.
2. **Write the host token file** (same value, no newline — Prometheus reads it),
   then **chown it to the Prometheus container's user**:
   `op read 'op://VaultRun-Prod/METRICS_TOKEN/password' | tr -d '\n' > /etc/vaultrun/metrics-token && chmod 600 /etc/vaultrun/metrics-token && chown 65534:65534 /etc/vaultrun/metrics-token`.
   This file MUST exist before Prometheus is (re)created — a missing
   `credentials_file` makes Prometheus fail to start (and a missing host path makes
   Docker create an empty directory at the mount). It persists across reboots.
   **The `chown 65534:65534` is REQUIRED** (verified on prod 2026-06-04): the
   `prom/prometheus` image runs as user **nobody (uid 65534)**, so a `chmod 600`
   file owned by `root` is **unreadable** to it — the `vaultrun-api` target then
   goes DOWN with `unable to read file /etc/prometheus/metrics-token: permission
   denied`. Keep `chmod 600`; the chown makes it readable to Prometheus only.
   This is safe because **the APP reads `METRICS_TOKEN` from its env** (injected by
   `op run`), **not from this file** — only Prometheus reads the file, so handing
   the file to uid 65534 does not affect the API. (The token value need not be any
   particular length; the app's env value and this host file just have to be the
   same string resolved from the one 1Password item.)
3. **Commit + pull the 3 activation configs** (deferred from the H5 code commit so
   routine deploys/reboots stay safe until the secret+file exist): add
   `METRICS_TOKEN=op://VaultRun-Prod/METRICS_TOKEN/password` to `op.prod.env`; add an
   `authorization: { type: Bearer, credentials_file: /etc/prometheus/metrics-token }`
   block to the `vaultrun-api` job in `monitoring/prometheus/prometheus.yml`; add the
   `- /etc/vaultrun/metrics-token:/etc/prometheus/metrics-token:ro` volume to the
   `prometheus` service in `monitoring/docker-compose.yml`. Then `git pull` on the VPS.
4. **Deploy the API** (injects the token → `/metrics` locked, `/health` slimmed):
   `./op-compose.sh up -d --build`.
5. **Recreate Prometheus** (a new volume needs recreate, not just restart):
   `docker compose -f monitoring/docker-compose.yml up -d prometheus`.
6. **Verify:** `curl -si localhost:3001/metrics | head -1` → 401;
   `curl -si -H "Authorization: Bearer $(cat /etc/vaultrun/metrics-token)" localhost:3001/metrics | head -1` → 200;
   `curl -s localhost:3001/health` → `{"status":"ok"}` only (no deps);
   `curl -s 'http://127.0.0.1:9090/api/v1/targets' | grep -o '"health":"[a-z]*"' | sort | uniq -c` → `vaultrun-api` up.
   If `vaultrun-api` is DOWN after this, check the Prometheus log
   (`docker logs vaultrun-prometheus --tail 20`) for the cause:
   - **`permission denied` reading `/etc/prometheus/metrics-token`** → the host file
     is owned by `root` but Prometheus runs as nobody (uid 65534). Fix:
     `chown 65534:65534 /etc/vaultrun/metrics-token` (keep `chmod 600`), then the
     next scrape goes green. (This was the one hiccup on the 2026-06-04 activation —
     see step 2.)
   - **`401` / server returned HTTP 401** → the app token and the host file disagree,
     almost always a trailing newline; rewrite with `tr -d '\n'`.
   UNDO: remove the `op.prod.env` ref + redeploy (token unset → open again).

**Create the Telegram bot (one-time):**
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the
   **bot token**.
2. Message your new bot anything (so it may DM you), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser → copy
   `result[].message.chat.id` (an integer). (Or message **@userinfobot** for your id.)
3. On the VPS: `cp monitoring/alertmanager/alertmanager.yml.example
   monitoring/alertmanager/alertmanager.yml` and paste the token + chat id.

**Deploy alerting:** `docker compose -f monitoring/docker-compose.yml up -d`
(adds Alertmanager). To pick up changed Prometheus **rules**, restart that container
(`docker compose -f monitoring/docker-compose.yml restart prometheus`) — the
`/-/reload` endpoint is disabled here (see the OPS GOTCHA above). Check rules at
`http://127.0.0.1:9090/alerts`, Alertmanager at scrape-internal `alertmanager:9093`.

**Status:** G-1 (Prometheus + node-exporter) ✓, G-2 (Grafana + dashboard) ✓,
G-3 (Alertmanager → Telegram + backup dead-man's-switch) ✓.

---

## 11. Error tracking (Sentry) — code 2026-06-02

App-level error tracking via **`@sentry/bun`** (the Bun-native SDK). Captures
unhandled + 5xx exceptions with stack traces + request path/method, plus
process-level uncaughtException/unhandledRejection. **No-op unless `SENTRY_DSN`
is set** — the app runs unchanged without it.

- Code: `src/observability/sentry.ts` (`initSentry()` is the first call in
  `main.ts`) + `src/observability/all-exceptions.filter.ts` (global filter →
  Sentry for unexpected/5xx; normal 4xx client errors are NOT sent). Smoke:
  `bun scripts/sentry-smoke.ts`.
- **Enable:** create a Sentry project (platform **Bun** or Node), copy its DSN,
  store it in 1Password as `op://VaultRun-Prod/SENTRY_DSN/password` (§12; optionally
  `SENTRY_RELEASE=<git-sha>`), then redeploy (`./op-compose.sh up -d --build`).
- Complements Prometheus `vaultrun_errors_total` + the `ErrorSpike` alert (the
  counts) with the actual error detail.

---

## 12. Secrets management (1Password) — built 2026-06-02

Production secrets live in the **1Password** vault **`VaultRun-Prod`** and are
injected into the stack **at deploy time only** — nothing secret is written to
disk. Closes the Phase-1 "secrets → manager" item.

**What's where**
- 1Password vault `VaultRun-Prod`, three items (type *Password*): `POSTGRES_PASSWORD`,
  `JWT_SECRET`, `SENTRY_DSN` (value in the `password` field).
- `op.prod.env` (in the repo, **not secret** — only `op://…` references).
- `op-compose.sh` (wrapper): loads the service-account token and runs
  `op run --env-file=op.prod.env -- docker compose -f docker-compose.prod.yml "$@"`.
  `op run` resolves the references and hands the values to compose as in-memory env
  vars; `docker-compose.prod.yml` reads them via `${VAR}` interpolation with `:?`
  guards (a missing secret fails the deploy loudly instead of starting degraded).
- **Service-account token** at `/etc/vaultrun/op-sa-token` (chmod 600, root) — the
  single "secret zero" on the box; the service account has **read-only** access to
  the `VaultRun-Prod` vault.
- `op` CLI installed from the official 1Password apt repo (package `1password-cli`).

**Deploy / ops** — always via the wrapper:
```bash
cd ~/vault-runner-api && git pull
./op-compose.sh up -d --build      # deploy / redeploy
./op-compose.sh ps                 # status
./op-compose.sh logs -f api        # logs
docker restart vaultrun-api        # plain restart needs no op (uses stored config)
```
**Reboot-safe:** Docker stores the already-resolved env in the container config, so
`restart: unless-stopped` brings the stack back after a reboot **without** needing
1Password — `op` is only needed when you run `./op-compose.sh up`.

**Rotate a secret** (e.g. `JWT_SECRET`): change the value in 1Password →
`./op-compose.sh up -d --force-recreate`. To rotate the **DB** password you must also
`ALTER USER` on Postgres (its password only re-inits on an empty data dir).

**Operator reporting key + optional `REPORTING_KEY_PEPPER` (Phase 3.5).** Operators
authenticate to `/api/operator/reports/*` with a per-operator key
(`Authorization: Bearer vrk_<operatorId>.<secret>`). Only the **hash** is stored
(`Operator.reportingApiKeyHash`); the plaintext is shown **once** by the provisioning
CLI (`bun scripts/operator-provision.ts --code <op> --rotate-reporting-key`) — store
it in 1Password and share it with the operator.
- **`REPORTING_KEY_PEPPER` is OPTIONAL.** Unset → keys are hashed `sha256:<secret>`
  (safe: the secret is 256-bit CSPRNG, not a password). Set → `hmac-sha256:<…>`, which
  adds defense against a DB-only leak. To enable: create `REPORTING_KEY_PEPPER` in
  `VaultRun-Prod` (Password), add `REPORTING_KEY_PEPPER=op://VaultRun-Prod/REPORTING_KEY_PEPPER/password`
  to `op.prod.env`, and **mint keys with the same pepper** (run the provisioning CLI
  via `op run` so it sees the same value the app does).
- **The stored hash is self-describing** (`sha256:`/`hmac-sha256:` prefix), so a
  `sha256` key keeps verifying even if a pepper is later added — only **peppered** keys
  need the pepper present. If a peppered key's pepper goes missing the app logs a
  distinct `reporting key is peppered but REPORTING_KEY_PEPPER is unset` warning (not a
  silent 401). Rotating/removing the pepper invalidates existing **peppered** keys →
  re-issue them. The provisioning CLI prints which hash mode it used.

**First-time setup** (already done for prod, 2026-06-02):
1. Create the vault `VaultRun-Prod` + the three *Password* items.
2. Create a 1Password **service account** (a Teams/Business feature) with read
   access to that vault; place its token at `/etc/vaultrun/op-sa-token` (chmod 600).
3. Install the CLI: add the 1Password apt repo → `apt install 1password-cli`.
4. Verify references resolve **without printing secrets**:
   `OP_SERVICE_ACCOUNT_TOKEN=$(cat /etc/vaultrun/op-sa-token) op run --env-file=op.prod.env -- sh -c 'echo ${#JWT_SECRET}'`
5. `./op-compose.sh up -d`, confirm `/health`, then remove any old plaintext `.env`.

**Recover a `.env`** (emergency/local only): `op inject -i op.prod.env -o .env` with
the token set — but prefer the wrapper so nothing ever hits disk.

---

## 13. Staging environment — built 2026-06-02

A separate, **isolated** copy of the stack for load/chaos testing and pre-prod
validation — never against the live demo DB.

**Host:** a dedicated **Hetzner Cloud** VPS (CPX22 — 2 vCPU AMD / 4 GB, Falkenstein,
Ubuntu 24.04), IP `178.105.149.146`. SSH `ssh vaultrun-staging` (Mac alias → root +
the same `~/.ssh/vaultrun_ed25519` key). Key-only SSH, ufw 22 + 443-from-Cloudflare,
Docker + `op` CLI installed exactly like prod.

**Stack:** the SAME `docker-compose.prod.yml`, deployed via **`op-compose.staging.sh`**
(thin wrapper that sets `OP_ENV_FILE=op.staging.env`). Secrets come from a separate
1Password vault **`VaultRun-Staging`** (`POSTGRES_PASSWORD`, `JWT_SECRET`; staging runs
without Sentry) via its own read-only service-account token at
`/etc/vaultrun/op-sa-token` on the staging box. Own Postgres/Redis volumes — fully
isolated from prod.

**Edge:** mirrors prod exactly — host **Caddy** :443 with the same Cloudflare Origin
cert (`*.vaultrun.app` covers it) + **mTLS** (`require_and_verify`, trust `cf-ca.crt`),
behind Cloudflare (Full strict + zone-level Authenticated Origin Pulls). Public URL
**https://staging-api.vaultrun.app** (Cloudflare A record `staging-api` → staging IP,
proxied). `cf-ufw-allow.timer` keeps :443 open only to Cloudflare IPs.

**Deploy / redeploy:**
```bash
ssh vaultrun-staging
cd ~/vault-runner-api && git pull
./op-compose.staging.sh up -d --build
curl -s http://127.0.0.1:3001/health                 # local
curl -s https://staging-api.vaultrun.app/health      # through the edge
```

**Load testing (k6).** Run ON the staging box against localhost (bypasses Cloudflare;
writes to the staging DB, never prod). Raise the per-IP rate limit for a single-source
test, then revert:
```bash
cd ~/vault-runner-api
THROTTLE_LIMIT=2000000 ./op-compose.staging.sh up -d        # raise limit for the test
docker run --rm --network host -e BASE_URL=http://localhost:3001 -e VUS=50 \
  -v "$PWD/load:/load" grafana/k6 run /load/k6-http.js
./op-compose.staging.sh up -d                              # revert to prod-default (120/min)
```
Result 2026-06-02: **0% errors, read p95≈34 ms at 50 VUs / ~186 req/s** (gates
p95<200 / p99<500 — passed comfortably). Chaos: Postgres-down → `/health` 503 →
recovers; API restart → engine recovers in-flight rounds (Phase 1.4). The WebSocket
bet/cash-out hot path is load-tested separately with `bun scripts/load-test.ts`.

**Rate limiting** (`THROTTLE_LIMIT` / `THROTTLE_TTL_MS`). The API rate-limits per
**real client IP** — `CF-Connecting-IP` behind the mTLS edge (see
`src/common/ip-throttler.guard.ts`), default 120 requests / 60 s. Both are env-tunable
(wired into `docker-compose.prod.yml`); raise `THROTTLE_LIMIT` for single-source load
tests. Without this the throttler would track the reverse-proxy IP and rate-limit all
users as one bucket.

---

## 14. Fairness — epochs & block-hash salt — built 2026-06-02 (Phase 2)

The crash is provably fair (seed chain + salt → HMAC → crash; see
`docs/provably-fair-guide.md`). Two operational facts:

**Epochs + auto-rollover.** The seed chain is split into epochs (`fairness_chains`
table). When an epoch runs out the engine **automatically rolls over** to a fresh
epoch — the old ~2-day "chain exhausted" stall is gone; **no manual reset needed.**
`FAIRNESS_CHAIN_LENGTH` (default 10000) sets seeds per epoch.

**Salt source — `SALT_PROVIDER_TYPE`:**
- `random` (default; staging) — operator-published random salt.
- `eth-block` (**prod**, persisted in `op.prod.env`) — **grind-proof**: each epoch's
  salt is the hash of a *future finalized Ethereum block*, committed before the block
  exists. The engine pre-commits + arms the next epoch in the background
  (`maintain()` each round); the public commitment (target block) is visible at
  `GET /api/fairness/current` → `nextEpoch`. If the oracle is unavailable it falls
  back to a random salt so the game never stalls.
  - Oracle: `src/fairness/eth-block.ts`, reads the **finalized** chain (reorg-safe),
    cross-checks across several public RPCs (`ETH_RPC_URLS`, default
    publicnode/drpc/blastapi/nodies; `ETH_SALT_LEAD_BLOCKS` default 10).

**Flip prod random ↔ eth-block:** edit the `SALT_PROVIDER_TYPE` line in `op.prod.env`
→ commit → `./op-compose.sh up -d --force-recreate`. (`op run` passes plain
`KEY=value` lines from `op.prod.env` through, so the value persists across deploys.)

**Reset fairness (rarely needed now):** `docker stop vaultrun-api` FIRST (else the
running engine re-creates a chain mid-reset), then `DELETE FROM game_rounds; DELETE
FROM fairness_seeds; DELETE FROM fairness_chains;` (FK order), then `./op-compose.sh
up -d`.

---

## Notes
- Data persists in Docker volumes (`pgdata`, `redisdata`) across restarts.
- This is the **play-money** build. Real-money launch additionally needs the
  Stage 2b items (KYC/AML, licensing, real crypto wallet, anti-fraud, admin,
  monitoring) — see `docs/stage2-architecture.md` in the web repo.
- Back up Postgres periodically:
  `docker exec vaultrun-postgres pg_dump -U vault vaultrun > backup.sql`
