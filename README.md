# Vault Run API

Server-authoritative, provably-fair backend for the Vault Run crash game.
Stack: **NestJS + PostgreSQL + Redis + Prisma**, run with **bun**.
Stage 2 demo: **play-money** (no real money / KYC / license yet).

Design: see `docs/stage2-architecture.md` in the web repo.

## Status

**M0 — scaffold.** Boots a NestJS app with a `/health` endpoint. Prisma schema
and `docker-compose` for Postgres + Redis are in place; services not yet wired.

## Prerequisites

- [bun](https://bun.sh) (used as runtime + package manager)
- Docker (for Postgres + Redis) — or a managed/VPS Postgres + Redis

## Setup

```bash
bun install
cp .env.example .env          # adjust if needed

# start infra (needs Docker):
docker compose up -d

# generate client + run first migration (needs a reachable Postgres):
bun run prisma:generate
bun run prisma:migrate

# run the API:
bun run dev                   # http://localhost:3001/health
```

Without Docker, point `DATABASE_URL` / `REDIS_URL` at any reachable Postgres/Redis
(e.g. on the Vultr VPS) and skip `docker compose`.

## Roadmap (milestones)

M0 scaffold · M1 auth · M2 wallet/ledger · M3 fairness · M4 game engine ·
M5 WS gateway · M6 bets/cashout/settle · M7 read APIs · M8 frontend swap ·
M9 hardening. See the architecture doc for details.
