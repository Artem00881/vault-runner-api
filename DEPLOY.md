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

Open the firewall for the API port (and SSH):
```bash
ufw allow 22 && ufw allow 3001 && ufw --force enable
```
Now `http://<YOUR_VPS_IP>:3001/health` works from anywhere.

Useful later:
```bash
docker compose -f docker-compose.prod.yml logs -f api   # live logs
docker compose -f docker-compose.prod.yml up -d --build # redeploy after git pull
docker compose -f docker-compose.prod.yml down          # stop (keeps data)
```

---

## 6. HTTPS (required for the live web app)

The web app is served over **HTTPS**, and browsers block a secure page from
talking to an insecure (`http://` / `ws://`) backend. So for the public web app
to connect, the API must be served over **HTTPS (wss://)**. This needs a domain
(step 1) and a reverse proxy. **Caddy** does TLS automatically:

```bash
# install Caddy
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

# configure: proxy your domain → the API (Caddy gets a free Let's Encrypt cert)
cat > /etc/caddy/Caddyfile <<'EOF'
api.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF
systemctl restart caddy
```
Now `https://api.yourdomain.com` is the secure API URL. (You can close port 3001
to the public and only expose 80/443 via Caddy: `ufw delete allow 3001`.)

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

## Notes
- Data persists in Docker volumes (`pgdata`, `redisdata`) across restarts.
- This is the **play-money** build. Real-money launch additionally needs the
  Stage 2b items (KYC/AML, licensing, real crypto wallet, anti-fraud, admin,
  monitoring) — see `docs/stage2-architecture.md` in the web repo.
- Back up Postgres periodically:
  `docker exec vaultrun-postgres pg_dump -U vault vaultrun > backup.sql`
