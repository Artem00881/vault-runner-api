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

```bash
cp .env.production.example .env
nano .env
```
Set:
- `POSTGRES_PASSWORD` → a long random password.
- `JWT_SECRET` → a long random string (e.g. `openssl rand -hex 32`).
- `CORS_ORIGIN` → your web app's URL (e.g. `https://your-app.lovable.app`).
  Use `*` only for quick testing.

Save (Ctrl+O, Enter, Ctrl+X).

---

## 5. Launch

```bash
docker compose -f docker-compose.prod.yml up -d --build
```
This builds the API image, starts Postgres + Redis, runs database migrations
automatically, and starts the server on port **3001**.

Check it:
```bash
docker compose -f docker-compose.prod.yml ps          # all "Up", postgres healthy
curl http://localhost:3001/health                      # {"status":"ok",...}
docker logs vaultrun-api --tail 20                      # "Game engine started"
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
docker compose -f docker-compose.prod.yml logs -f api   # live logs
docker compose -f docker-compose.prod.yml up -d --build # redeploy after git pull
docker compose -f docker-compose.prod.yml down          # stop (keeps data)
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
  chain exhausted), `ErrorSpike`, `HostDiskLow`, `HostMemoryHigh`.
- `alertmanager/alertmanager.yml` (gitignored; copy from `.yml.example`) — routes
  to a Telegram bot. The dead-man's-switch metric is written by the backup script
  (§9) into `/etc/vaultrun/node-textfile/` and exposed by node-exporter.

**Create the Telegram bot (one-time):**
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the
   **bot token**.
2. Message your new bot anything (so it may DM you), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser → copy
   `result[].message.chat.id` (an integer). (Or message **@userinfobot** for your id.)
3. On the VPS: `cp monitoring/alertmanager/alertmanager.yml.example
   monitoring/alertmanager/alertmanager.yml` and paste the token + chat id.

**Deploy alerting:** `docker compose -f monitoring/docker-compose.yml up -d`
(adds Alertmanager, reloads Prometheus rules). Check rules at
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
  set `SENTRY_DSN=...` (optionally `SENTRY_RELEASE=<git-sha>`) in the VPS `.env`,
  then redeploy (`docker compose -f docker-compose.prod.yml up -d --build`).
- Complements Prometheus `vaultrun_errors_total` + the `ErrorSpike` alert (the
  counts) with the actual error detail.

---

## Notes
- Data persists in Docker volumes (`pgdata`, `redisdata`) across restarts.
- This is the **play-money** build. Real-money launch additionally needs the
  Stage 2b items (KYC/AML, licensing, real crypto wallet, anti-fraud, admin,
  monitoring) — see `docs/stage2-architecture.md` in the web repo.
- Back up Postgres periodically:
  `docker exec vaultrun-postgres pg_dump -U vault vaultrun > backup.sql`
