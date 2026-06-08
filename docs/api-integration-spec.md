# Vault Run — API Integration Specification (Seamless Wallet / RGS)

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operator / aggregator integration engineers

Vault Run is a server-authoritative multiplayer **crash** game delivered as a
**Remote Game Server (RGS)**. This document is the primary technical reference for
integrating it into an online-casino platform via the **seamless-wallet** model:
the operator's wallet remains the single source of truth for player funds; the RGS
never holds money. It covers onboarding, the signed launch protocol, the WebSocket
game protocol, the seamless-wallet HTTP contract the operator implements, money &
idempotency semantics, reconciliation, error codes, reporting, and a full worked
example.

Companion documents: `game-math-spec.md` (crash math, RTP, limits, rounding),
`provably-fair-guide.md` (verifiable crash points), `simulation-report.md`
(empirical RTP validation).

Source of truth (this spec is derived from, and must stay consistent with, the
production code):
`src/operator/launch-token.service.ts`, `src/operator/game-session.service.ts`,
`src/operator/operator.controller.ts`, `src/operator/reporting.controller.ts`,
`src/game/game.gateway.ts`, `src/game/ws-schemas.ts`, `src/game/bets.service.ts`,
`src/wallet/operator-wallet.types.ts`, `src/wallet/http-operator-wallet.ts`,
`src/wallet/seamless-operator-wallet.ts`, `src/common/currency.ts`,
`scripts/operator-provision.ts`, `scripts/operator-recon-check.ts`,
reference operator wallet: `load/operator-wallet-stub.ts`.

> Convention: a path written `POST /bet` (no `/api` prefix) is a route **you, the
> operator, expose** and the RGS calls. A path written `POST /api/operator/launch`
> is a route **the RGS exposes** and you call. All money values on the wire are
> **integer minor units** (see §8).

---

## 1. Overview & integration model

- **Seamless wallet.** Vault Run never stores or holds player balances. On every
  stake and payout the RGS calls **your** wallet API (`/bet`, `/win`, `/rollback`,
  `/balance`). Your ledger is authoritative; ours is a local journal used only for
  reconciliation and reporting.
- **Server-authoritative game.** One global round runs on the RGS clock. All
  players see the same rising multiplier and the same crash point. The crash point
  is fixed before betting closes by a provably-fair commitment (see
  `provably-fair-guide.md`) — the server cannot change it after bets are placed, and
  the client multiplier is never trusted for money decisions.
- **Currency-agnostic, multi-currency from day one.** The crash math operates on
  integer minor units and is identical across currencies; only the **money limits**
  are per-currency (§8, `game-math-spec.md` §12).
- **Multi-tenant.** Each operator is a tenant identified by an `operatorId`, with
  its own launch secret, wallet endpoint, currency allow-list, bet limits,
  responsible-gambling config, and reporting key.

Responsibilities at a glance:

| Concern | Operator (you) | Vault Run (RGS) |
|---|---|---|
| Player funds / balances | **Authoritative ledger** | Local journal only |
| Player identity | `playerId` (your id) | Local journal user keyed to `op:{operatorId}:{playerId}:{currency}` |
| Launch token signing | **Sign with your `launchSecret`** | Verify + open session |
| Game logic, RNG, crash point | — | **Authoritative** |
| Stake debit / payout credit | **Implement `/bet`, `/win`, `/rollback`, `/balance`** | Call them idempotently |
| Idempotency / dedup of money moves | **Dedup on `transactionId`** | Send a unique `transactionId` per move |
| Bet/round limits | Provide per-currency config at onboarding | Enforce them server-side |
| Responsible gambling | Provide RG config at onboarding | Emit reality checks / session limits |
| Reconciliation | Match against our reports / your book | Provide reporting API + round history |

---

## 2. End-to-end architecture & flow

```
 ┌────────────┐   1. launch token (signed w/ launchSecret)   ┌──────────────┐
 │  Operator   │ ────────────────────────────────────────▶   │  Game client  │
 │  lobby      │      (player clicks "play Vault Run")        │  (browser)    │
 └────────────┘                                               └──────┬───────┘
        ▲                                                            │ 2. POST /api/operator/launch { token }
        │                                                            ▼
        │                                                     ┌──────────────┐
        │  4. /bet  /win  /rollback  /balance (seamless)      │  Vault Run    │
        │ ◀────────────────────────────────────────────────  │  RGS          │
        │                                                     │  (REST + WS)  │
        │                                                     └──────┬───────┘
        │                                                            │ 3. session token → WS handshake
        └─────────────── 5. reporting / reconciliation ─────────────┘    (place_bet / cash_out)
```

Sequence (happy path):

```
Player        Operator lobby      Game client        Vault Run RGS        Operator wallet
  │  click play    │                   │                    │                   │
  ├───────────────▶│                   │                    │                   │
  │                │ issue launch JWT  │                    │                   │
  │                │ (sign w/ secret)  │                    │                   │
  │                ├──────────────────▶│                    │                   │
  │                │                   │ POST /api/operator/launch {token}      │
  │                │                   ├───────────────────▶│ verify sig+exp+jti│
  │                │                   │   { token (session), sessionId, … }    │
  │                │                   │◀───────────────────┤                   │
  │                │                   │ WS connect auth.token = session token  │
  │                │                   ├───────────────────▶│ round_state…      │
  │                │                   │ place_bet {A, amount}                  │
  │                │                   ├───────────────────▶│ POST /bet {txId}  │
  │                │                   │                    ├──────────────────▶│ debit
  │                │                   │                    │  {operatorTxId,bal}│
  │                │                   │                    │◀──────────────────┤
  │                │                   │  bet_accepted / balance_updated        │
  │                │                   │◀───────────────────┤                   │
  │                │                   │ …multiplier_update…│                   │
  │                │                   │ cash_out {A}       │                   │
  │                │                   ├───────────────────▶│ POST /win {txId}  │
  │                │                   │                    ├──────────────────▶│ credit
  │                │                   │  cashout_accepted / balance_updated    │
  │                │                   │◀───────────────────┤                   │
```

---

## 3. Onboarding & provisioning

We onboard an operator as an `Operator` row (CLI:
`scripts/operator-provision.ts`, upsert by `--code`). Provisioning is a two-party
exchange.

**What you (the operator) provide us:**

| Item | Required | Notes |
|---|---|---|
| Operator code | yes | Short stable slug (`--code`), e.g. `demo-casino`. |
| Display name | optional | `--name`. |
| Wallet API base URL | yes (real money) | `--wallet-url`, e.g. `https://op.example/wallet`. The RGS POSTs `/bet`, `/win`, `/rollback`, `/balance` under it. |
| Wallet API key | recommended | `--wallet-key`. Sent as `Authorization: Bearer <key>` on every wallet call (omitted if not configured). |
| Currency allow-list | yes | `--currencies EUR,USDT`. Canonicalised to uppercase (ISO-4217). A launch whose currency is not in this list is rejected. An **empty list rejects every launch** (fail-closed). |
| Per-currency bet limits | recommended | `--bet-limits` JSON (or `@file.json`): per-currency `minBet`, `maxBet`, `maxWinPerBet` in minor units. Absent → global house defaults (which are demo-grade — see §8). |
| Responsible-gambling config | optional | `--rg-config` JSON: reality-check interval, max session duration, per-currency session loss/wager caps (§11). |
| Return-to-lobby URL | optional | `--callback-url`. Returned to the client at launch so it knows where to send the player on exit. |
| IP allow-list | optional | `--ip-whitelist` for the **reporting** API (the wallet calls are outbound from us to you). |
| Demo (fun-mode) capability | optional | `--demo-enabled` if your jurisdiction permits play-money demo launches. Off by default. |

**What we issue back to you:**

| Item | When | Notes |
|---|---|---|
| `operatorId` | on create | A UUID — our routing / tenant key. Appears in reporting tokens and is the `operatorId` the RGS uses internally to route wallet calls; it is **not** part of the wallet request bodies (you already know who you are). |
| `launchSecret` | on create / `--rotate-secret` | A 32-byte hex HMAC secret. **You sign launch tokens with it (HMAC-SHA256).** Shown **once** — store it securely. Rotating it invalidates outstanding launch tokens. |
| Reporting API key | on `--rotate-reporting-key` | `vrk_<operatorId>.<secret>` — used as `Authorization: Bearer <key>` against the reporting API (§13). Shown once. |

> Secrets are printed once by the CLI and must be stored in your secret manager.
> The example commands and tokens in this document use placeholders only.

---

## 4. Launch-token protocol

Source of truth: `src/operator/launch-token.service.ts`.

When a player launches the game from your lobby, **you** mint a short-lived JWT
("launch token" / ticket) signed with your `launchSecret` (HMAC-SHA256) and pass it
to the game client, which hands it to the RGS. Industry-standard ticket model:
single operator-held secret, short expiry, one-time use.

**JWT claims:**

| Claim | Type | Required | Meaning |
|---|---|---|---|
| `operatorId` | string | yes | Your `operatorId` (UUID). Tells the RGS which secret to verify with. |
| `playerId` | string | yes | Your player/account/session id. The RGS uses this as the wallet `playerId`. |
| `currency` | string | yes | ISO-4217 code. Must be in your allow-list (case-insensitive). |
| `locale` | string | optional | BCP-47-ish; normalized server-side. |
| `demo` | boolean | optional | `true` = play-money "fun mode" (settles on our internal ledger, never your wallet). Requires `demoEnabled`. Default `false`. |
| `ctx` | object | optional | Free-form per-launch context (e.g. limit/round hints). Echoed nowhere security-sensitive. |
| `jti` | string (UUID) | yes | Unique token id. **Consumed exactly once.** |
| `exp` | number | yes | Expiry. TTL is **120 seconds** (`TTL_SECONDS`). |

**Signing (operator side):** HMAC-SHA256 over the standard JWT structure with
`secret = launchSecret`, a unique `jti`, and `exp = now + 120s`.

**Verification (RGS side, `verify()`), in order:**

1. Decode unverified to read `operatorId`; unknown/missing → `invalid_launch_token`.
2. Look up the operator; missing or disabled → `unknown_operator`.
3. Verify signature + expiry with **that operator's** `launchSecret`; failure (bad
   signature or expired) → `invalid_launch_token`.
4. `currency` must be in the operator's allow-list (case-insensitive) →
   else `currency_not_allowed`.
5. If `demo === true`, the operator must have `demoEnabled` → else `demo_not_allowed`.
6. `jti` must be present and **not already consumed** → else
   `invalid_launch_token` / `launch_token_already_used`.

The `jti` is consumed only when the session is actually created (step 5 of §5), so a
token rejected for `currency_not_allowed` or `demo_not_allowed` is **not** burned —
you may re-issue a corrected token. All verification failures surface as HTTP
**401** with the error string as the message.

Example launch JWT payload (before signing):

```json
{
  "operatorId": "11111111-1111-1111-1111-111111111111",
  "playerId": "player-42",
  "currency": "EUR",
  "locale": "en",
  "demo": false,
  "ctx": {},
  "jti": "9c1d…unique…",
  "iat": 1750000000,
  "exp": 1750000120
}
```

---

## 5. Launch endpoint & session token

Source of truth: `src/operator/operator.controller.ts`,
`src/operator/game-session.service.ts`.

### `POST /api/operator/launch`

Open the game from a launch token. No auth header — the launch token itself is the
credential.

Request body:

```json
{ "token": "<launch JWT signed with your launchSecret>" }
```

`token` must be a string of length ≥ 10, else **400** `invalid_body`. A failed
launch-token verification is **401** with the error from §4.

Success **200** response:

```json
{
  "token": "<session/play token — used for the WS handshake>",
  "sessionId": "b8…uuid",
  "walletId": "c1…uuid",
  "currency": "EUR",
  "decimals": 2,
  "locale": "en",
  "callbackUrl": "https://op.example/lobby"
}
```

| Field | Meaning |
|---|---|
| `token` | The **session (play) token** the game client uses as the WebSocket `auth.token`. Signed with **our** JWT secret (not your launch secret). Short-lived (see below). |
| `sessionId` | The `GameSession` id. Re-validated as live at WS connect; revoking it (see below) disconnects/blocks the player even before the JWT expires. |
| `walletId` | Our local journal wallet id (one per `operator`+`player`+`currency`). Not authoritative for balance in operator mode. |
| `currency` | Canonical uppercase currency for this session. |
| `decimals` | Display precision for `currency` (so the client renders minor units correctly from first paint). |
| `locale` | Normalized locale. |
| `callbackUrl` | Your return-to-lobby URL, or `null` if unset. |

Session-token lifetime: `SESSION_TOKEN_TTL_SEC`, **default 4 hours**, clamped to
**60 s … 24 h** (out-of-range/non-numeric falls back to 4 h). To refresh, re-launch.
A leaked session token is therefore bounded in time **and** revocable via the
session (below).

Demo launches: a `demo:true` launch funds a separate play-money journal wallet to a
fixed bankroll on **each** launch (reset-to-full) and always settles on the internal
ledger — your wallet is never touched.

### `POST /api/operator/session/close`

Authenticated by the player's **own session token** (`Authorization: Bearer
<session token>`). Soft-revokes every live `GameSession` bound to that wallet (a
logout): the session can no longer reconnect or bet, while in-flight settlements
still resolve. A guest (no session-bound wallet) is a no-op.

Response **200**:

```json
{ "ok": true, "revoked": 1 }
```

---

## 6. WebSocket game protocol

Source of truth: `src/game/game.gateway.ts`, `src/game/ws-schemas.ts`,
`src/game/bets.service.ts`.

Transport: **Socket.IO**. The client connects with the session token:

```js
const socket = io("wss://sandbox.vaultrun.example", {
  auth: { token: "<session/play token from /api/operator/launch>" },
});
```

- A valid token authorizes betting/cash-out for that player.
- **Guests may connect with no token** — they receive all read-only round events
  (`round_state`, `multiplier_update`, `round_crashed`, `round_settled`) but any
  money action returns `not_authenticated`.
- An operator session token must still map to a **live** `GameSession` — a
  revoked/closed session is rejected at connect even if the JWT has not expired.
- **One active socket per user.** A second socket for the same user disconnects the
  previous one (multi-tab guard).
- **Per-socket rate limit: 15 messages/second** (`WS_MSG_LIMIT`). Excess messages
  are rejected with `{ ok:false, reason:"rate_limited" }` and not processed.

Every client→server message returns a Socket.IO **ack** (the callback). Most
actions ALSO emit a mirrored event to the player's room; for money actions the ack
and the emitted event carry the **same** result object.

### 6.1 Client → server messages

| Message | Payload | Ack / result |
|---|---|---|
| `subscribe_round` | _(none)_ | `{ ok:true }`; also (re)emits `round_state`. |
| `time_sync` | `{ t0?: number }` | `{ ok:true, t0, serverTime }` — NTP-style clock sync; `t0` is echoed, `serverTime` = server epoch ms. No auth. |
| `place_bet` | `{ panel:"A"\|"B", amount:number, autoCashout?:number }` | `BetResult` (see below). Emits `bet_accepted` or `bet_rejected` + `balance_updated` on success. |
| `cancel_bet` | `{ panel:"A"\|"B" }` | `BetResult`. Emits `bet_cancelled` or `bet_rejected` + `balance_updated`. |
| `cash_out` | `{ panel:"A"\|"B" }` | `CashoutResult`. Emits `cashout_accepted` or `cashout_rejected` + `balance_updated`. |
| `reality_check_ack` | _(none)_ | `{ ok:true }` — acknowledges a reality check (§11); unblocks new bets in enforce mode. |

**`place_bet` payload validation** (`placeSchema`, Zod):

- `panel` ∈ `"A"` (Quick Grab) | `"B"` (Big Heist).
- `amount` — a finite, positive **number in minor units** (e.g. `100` = €1.00 for
  EUR). Non-finite (NaN/Infinity) or non-positive → `invalid_payload`. The value is
  floored to an integer server-side; per-currency min/max are enforced (§8).
- `autoCashout` — optional, a finite number strictly **> 1**. The server cashes the
  bet out at exactly this target when reached (deterministic, tick-independent).

**Dual-bet model.** Panels A and B are two **independent positions sharing ONE
crash point** for the round (`game-math-spec.md` §4). Each has its own `amount`,
`autoCashout`, and cash-out state; you may bet one or both. Uniqueness is enforced
per `(roundId, userId, panel)` — one bet per panel per round.

`BetResult` shape (ack of `place_bet` / `cancel_bet`):

```json
{
  "ok": true,
  "panel": "A",
  "balance": 9900,
  "betId": "f3…uuid",
  "currency": "EUR"
}
```

On failure: `{ "ok": false, "reason": "<code>", "panel": "A" }` (no `betId`/`balance`).

`CashoutResult` shape (ack of `cash_out`):

```json
{
  "ok": true,
  "userId": "…",
  "panel": "A",
  "multiplier": 2.45,
  "payout": 24255,
  "balance": 34155,
  "currency": "EUR",
  "pending": false
}
```

`pending: true` (operator mode only) means the win is recorded but the operator
credit could not yet be confirmed; the RGS reconciler re-issues it (§9). When
`pending` is true, no `balance` is included (it is not yet authoritative).

### 6.2 Server → client events

| Event | Payload | When |
|---|---|---|
| `round_state` | `{ roundId, phase, phaseEndsAt, multiplier, serverTime }` | On connect, on `subscribe_round`, and on every phase transition. `phase` ∈ `waiting`\|`betting`\|`running`\|`crashed`\|`settling`\|`completed`. `phaseEndsAt`/`serverTime` are epoch ms. |
| `multiplier_update` | `{ roundId, multiplier, serverTime }` | ~Every 120 ms while `running`. Cosmetic pacing; never trusted for payout. |
| `round_crashed` | `{ roundId, crashMultiplier }` | At the crash. `crashMultiplier` is now public (the round's final multiplier). |
| `round_settled` | `{ roundId }` | After settlement bookkeeping completes (round fully closed). |
| `bet_accepted` | `BetResult` (`ok:true`) | A `place_bet` succeeded. |
| `bet_rejected` | `BetResult` / result (`ok:false, reason`) | A `place_bet`/`cancel_bet` was rejected. |
| `bet_cancelled` | `BetResult` (`ok:true`) | A `cancel_bet` refunded successfully. |
| `cashout_accepted` | `CashoutResult` (`ok:true`, may include `auto:true`, `pending`) | A manual OR auto cash-out paid. Auto-cashouts add `"auto": true`. |
| `cashout_rejected` | `CashoutResult` (`ok:false, reason`) | A `cash_out` was rejected (e.g. `too_late`). |
| `bet_busted` | `{ panel }` | The round crashed with this bet still active (stake lost). |
| `balance_updated` | `{ currency, balance }` | After any successful money move (bet/cancel/cash-out). `balance` is minor units; `currency` defaults to `"DEMO"` for play-money. |
| `reality_check` | `{ elapsedSec, wagered, won, net, currency, enforce }` | Responsible gambling — periodic reality check (§11). `enforce:true` ⇒ new bets blocked until `reality_check_ack`. |
| `session_time_limit` | `{ maxSessionSec }` | Responsible gambling — the session duration limit was reached; new bets are blocked (§11). |

> Note: `multiplier`/`crashMultiplier` are 2-decimal numbers (e.g. `2.45`). The
> crash point itself is **never** exposed before the crash — `round_state` while
> `running` only carries the live climbing multiplier, not the secret crash point.

---

## 7. Seamless wallet API (operator-implemented)

This is the heart of the integration. **You** expose four JSON-over-HTTP endpoints
under your `walletApiUrl`; the RGS calls them on every money move.

Source of truth: `src/wallet/operator-wallet.types.ts` (contract),
`src/wallet/http-operator-wallet.ts` (wire),
`src/wallet/seamless-operator-wallet.ts` (failure policy),
`load/operator-wallet-stub.ts` (reference implementation).

**Common request conventions:**

- Method `POST`, `Content-Type: application/json`.
- `Authorization: Bearer <walletApiKey>` is sent **when a key is configured** for
  the operator (omitted otherwise). Reject a missing/wrong key with **401**.
- URL = `{walletApiUrl}` + `/` + `{bet|win|rollback|balance}` (trailing/leading
  slashes are normalized).
- All amounts are **integer minor units** (§8).
- Per-request timeout on our side: `OPERATOR_WALLET_TIMEOUT_MS`, **default 3000 ms**
  (see §9 for what we do on timeout).

### 7.1 `POST /bet` — debit the stake

Request:

```json
{
  "playerId": "player-42",
  "currency": "EUR",
  "amount": "100",
  "transactionId": "bet:<roundId>:<userId>:A:debit",
  "roundId": "r-2026-0001",
  "betId": "f3…uuid"
}
```

Success **200**:

```json
{ "operatorTxId": "op-987", "balance": "9900" }
```

Insufficient funds — respond with **HTTP 402** or **409**, OR **200/4xx** with body
`{ "error": "insufficient_funds" }`. Any of these is treated as a clean business
rejection (the bet is rejected, not retried).

| Field | Meaning |
|---|---|
| `playerId` | Your player id (from the launch token). |
| `currency` | ISO-4217 code (uppercase). |
| `amount` | Positive minor units to debit (the stake), as a **BigInt-safe decimal string**. |
| `transactionId` | **Unique per money-move; dedup on this** (idempotency key). |
| `roundId`, `betId` | Our round/bet ids — context for your statement and reconciliation (key your book by `betId`). |
| `operatorTxId` (resp) | Your reference id for the applied transaction. |
| `balance` (resp) | Player balance after the move, minor units, as a **BigInt-safe decimal string**. |

### 7.2 `POST /win` — credit the payout

Request (same shape as `/bet`; `amount` is the positive payout):

```json
{
  "playerId": "player-42",
  "currency": "EUR",
  "amount": "24255",
  "transactionId": "bet:<betId>:payout",
  "roundId": "r-2026-0001",
  "betId": "f3…uuid"
}
```

Success **200**: `{ "operatorTxId": "op-988", "balance": "34155" }`.

A win is **never rolled back** by the RGS. If a `/win` call is ambiguous/unconfirmed
the RGS retries the idempotent `/win` (same `transactionId`) and, failing that,
records the bet `payout_pending` for its reconciler — so dedup correctly here or you
risk double-crediting (§9).

### 7.3 `POST /rollback` — undo a named transaction

Request:

```json
{
  "playerId": "player-42",
  "currency": "EUR",
  "transactionId": "bet:<roundId>:<userId>:A:debit",
  "roundId": "r-2026-0001",
  "betId": "f3…uuid"
}
```

Success **200**: `{ "operatorTxId": "op-989", "balance": "10000" }`.

- `transactionId` is the **id of the bet/win being undone** (not a new id).
- **Idempotent on its own effect:** if that transaction was applied, undo it; if it
  was never applied (or already rolled back), no-op. Either way return the current
  authoritative balance.
- The RGS issues `/rollback` to **compensate an ambiguous debit** (timeout) and
  during stranded-reservation recovery (§9). It is safe for you to receive a
  rollback for a `transactionId` you never saw.

### 7.4 `POST /balance` — read the authoritative balance

Request: `{ "playerId": "player-42", "currency": "EUR" }`
Success **200**: `{ "balance": "10000" }`.

Used by the RGS to serve `GET /api/wallet/balance` (the player's real balance comes
from you, not our journal).

### 7.5 Reference implementation

`load/operator-wallet-stub.ts` is a complete, runnable reference operator wallet (a
test/load stub): Bearer auth, per-`transactionId` idempotency with exact rollback,
402 on insufficient funds, and a per-`betId` "operator book" exposed at
`GET /debug/book` for reconciliation (§10). Use it to validate your client and to
understand the exact wire shapes.

---

## 8. Money model & currencies

Source of truth: `game-math-spec.md` §8/§12, `src/common/currency.ts`.

- **Integer minor units everywhere.** No floats on the wire. `100` EUR-minor =
  €1.00; `1_000_000` USDT-minor (6 dp) = 1.000000 USDT.
- **On the operator-wallet contract (§7), amounts and balances are sent as decimal
  strings** (`"amount"`, `"balance"`) — **parse with BigInt, never `Number`**. A
  single high-decimal-currency value can exceed 2^53 minor units (e.g. ETH at 18 dp:
  2^53 wei ≈ 0.009 ETH), which a JSON `number` would silently corrupt. The magnitude
  is unchanged — it is the integer count of minor units, just quoted.
- **Decimals are display-only.** No money math reads them; a wrong precision can
  only mis-scale a display, never corrupt a balance.
- **Payout = floor(stake × cashOutMultiplier)** in minor units (rounded down, toward
  the house), then clamped to the bet's max-win cap.
- **Currency-agnostic math, per-currency limits.** The crash distribution, RTP
  (97%), and payout formula are identical for every currency; only min/max stake,
  max-win-per-bet, etc. differ per currency (operator config; `game-math-spec.md`
  §12).
- **Real-money config (reference):** max multiplier **10,000x**, EUR-reference
  min **€0.10**, max **€100**, max win **€10,000/bet**, **€20,000/player/round**,
  operator exposure **€100,000/round**. The live demo uses generous play-money
  limits; supply your real per-currency `betLimits` at onboarding (the global RISK_*
  defaults are demo-grade and the RGS refuses to boot in operator mode without
  explicit ceilings).

### `GET /api/currencies` (public)

Returns the canonical per-currency precision table (cacheable, no auth):

```json
{
  "currencies": [
    { "code": "BTC",  "decimals": 8,  "name": "Bitcoin" },
    { "code": "EUR",  "decimals": 2,  "name": "Euro" },
    { "code": "ETH",  "decimals": 18, "name": "Ether" },
    { "code": "JPY",  "decimals": 0,  "name": "Japanese Yen" },
    { "code": "USDT", "decimals": 6,  "name": "Tether" }
  ]
}
```

Seeded codes today: `DEMO, EUR, USD, GBP, CHF, CAD, AUD, BRL, INR, JPY, USDT,
USDC, BTC, ETH`. An unknown code falls back to 2 decimals (flagged
`known:false`); to add a currency we add one reviewed row to the canonical table.

---

## 9. Idempotency, timeouts & money-safety

This section is the most important for correctness. Source of truth:
`src/wallet/http-operator-wallet.ts`, `src/wallet/seamless-operator-wallet.ts`.

**Idempotency (mandatory).** Every state-changing call (`/bet`, `/win`,
`/rollback`) carries a unique `transactionId`. You **MUST** dedup on it: a retry
with the same `transactionId` must return the same result and **never double-apply**.
The RGS derives stable keys per logical move, e.g.
`bet:{roundId}:{userId}:{panel}:debit` for a stake and
`bet:{betId}:payout` for a payout (a cancel refund is `bet:{betId}:refund`) —
so a retried bet dedups instead of charging twice.

**RGS-side response → outcome mapping (`/bet`, `/win`, `/rollback`):**

| Operator response | RGS interpretation |
|---|---|
| `200` + valid JSON | Applied. Continue. |
| `402` / `409` / body `{error:"insufficient_funds"}` | **Insufficient funds** — clean rejection (bet rejected; no retry). |
| `408` / `504` | **Operator-side timeout** — ambiguous (see below). |
| Other non-2xx (`4xx`/`5xx`) | **Operator error** — transient; retried a couple of times, then compensated/failed. |
| Client-side request timeout (AbortController, default 3000 ms) | **Ambiguous timeout** (the operator may or may not have applied it). |
| Other network failure (DNS, connection refused) | **Did not reach the operator** → definitely not applied → safe to retry. |

**The critical rule — ambiguous timeout on a DEBIT.** When a `/bet` call times out,
the RGS does **not** know whether you applied the debit, and it does **not**
blind-retry (that could double-charge). Instead it issues an **idempotent
`/rollback`** for that `transactionId` and rejects the bet. If you applied the
debit, the rollback reverses it; if you didn't, the rollback is a no-op. Either way
the player's balance ends correct and no bet is left half-applied.

```
RGS                                   Operator wallet
 │  POST /bet {transactionId=T}              │
 ├──────────────────────────────────────────▶│  (debit may or may not apply)
 │  ⌛ no response within 3000 ms             │
 │  ── client timeout → AMBIGUOUS ──          │
 │  POST /rollback {transactionId=T}          │
 ├──────────────────────────────────────────▶│  applied? → undo.  not applied? → no-op.
 │  {operatorTxId, balance}                   │
 │◀──────────────────────────────────────────┤
 │  reject bet → emit bet_rejected            │
 ▼  (player's balance is correct either way)
```

**The critical rule — ambiguous failure on a CREDIT (win).** A won payout is
**never** clawed back. On a `/win` failure the RGS retries the idempotent `/win`
(same `transactionId`); if it still cannot confirm, it marks the bet
`payout_pending` and a background reconciler re-issues the same idempotent `/win`
until you confirm. So your dedup on `transactionId` is what prevents a double credit
across these retries.

```
RGS                                   Operator wallet
 │  POST /win {transactionId=W}               │
 ├──────────────────────────────────────────▶│  ⌛ timeout / 5xx
 │  retry POST /win {transactionId=W}  (idem) │
 ├──────────────────────────────────────────▶│  dedup → credit applied once
 │  …if still unconfirmed → bet=payout_pending│
 │  reconciler re-issues /win {W} every ~30s  │
 ▼  until confirmed (never rolled back)
```

**Stranded-reservation recovery.** If a debit applied but the RGS could not finish
activating the bet locally, an age-gated sweep reverses it via the idempotent
`/rollback` (both wallet modes). You may therefore receive a `/rollback` for a
`transactionId` whose `/bet` you saw but whose bet never "ran" — undo it.

---

## 10. Reconciliation

Source of truth: `scripts/operator-recon-check.ts`, `load/operator-wallet-stub.ts`.

You keep your own ledger ("operator book"), ideally keyed by our **`betId`** (sent
on every `/bet`, `/win`, `/rollback`). Reconcile your book against our reporting
(§13) — and your own statement — on these invariants:

| Invariant | Statement |
|---|---|
| **Win linkage** | Every `cashed_out` bet got **exactly one** `/win`, with `win amount == bet.payout`. |
| **Busted purity** | Every `busted` bet got a `/bet` (debit) but **no** `/win`. |
| **Stake linkage** | Every wagered bet (`active`/`cashed_out`/`busted`/`payout_pending`) has a matching `/bet` debit `== amount`, net of any `/rollback`. |
| **Backlog drained** | No bet stuck in a transient state (`reserving`/`cancelling`/`payout_pending`) once the dust settles. |
| **Conservation** | On your book, `Σ(bet) − Σ(win) − Σ(rollback)` equals the net balance drop for those players, which equals `Σ stake(wagered) − Σ payout(cashed)`. (Note: a win pays the full `stake × multiplier`, not just the stake.) |

`scripts/operator-recon-check.ts` implements exactly these (`O1`–`O5`) against the
reference stub's `/debug/book`; for a real operator the equivalent input is your
transaction statement. We run this as a money-conservation gate after load soaks.

Per-bet money is keyed by stable ids you can match on:

- Stake `transactionId`: `bet:{roundId}:{userId}:{panel}:debit`.
- Payout `transactionId`: `bet:{betId}:payout` (a cancel refund is `bet:{betId}:refund`).
- The same `betId` accompanies the stake, the win, and any rollback for that bet.

---

## 11. Responsible-gambling events

Source of truth: RG config at provisioning (`--rg-config`), enforced in
`src/game/game.gateway.ts` (`rgEvaluate`) and `src/game/bets.service.ts`.

RG applies to **real-money sessions only** (demo and guests never carry RG). Config
is per-operator (with optional per-currency limits) and rides the signed session
token, so it cannot be stripped client-side. Supported controls:

| Control | Effect |
|---|---|
| Reality-check interval | Emits `reality_check` every N seconds with the session's `wagered`/`won`/`net` (minor units) and `elapsedSec`. |
| Reality-check enforce | If `enforce:true`, new bets are blocked (`reality_check_pending`) until the client sends `reality_check_ack`. |
| Max session duration | Emits `session_time_limit` once when reached; new bets are then blocked (`session_time_limit`). |
| Max session loss | Blocks a new bet that would push session net loss over the cap (`session_loss_limit`). |
| Max session wager | Blocks a new bet that would push session turnover over the cap (`session_wager_limit`). |

**Cash-out and cancel are never RG-blocked** — an at-risk player can always retrieve
their money; RG only gates *new* bets. The client should render reality-check and
time-limit prompts and call `reality_check_ack` when the player acknowledges.

---

## 12. Error-code catalog

All strings below are emitted verbatim by the code (no paraphrase).

**Launch / session (`POST /api/operator/launch`, HTTP 401 unless noted):**

| Code | Meaning |
|---|---|
| `invalid_body` | Missing/short `token` (HTTP **400**). |
| `invalid_launch_token` | Bad/expired signature, missing `operatorId`, or missing `jti`. |
| `unknown_operator` | Operator not found or disabled. |
| `currency_not_allowed` | `currency` not in the operator's allow-list. |
| `demo_not_allowed` | `demo:true` but the operator lacks `demoEnabled`. |
| `launch_token_already_used` | `jti` already consumed (replay). |
| `operator_disabled` | Operator disabled (also at token issue). |

**WebSocket message rejections** (in the ack `{ ok:false, reason }` and/or
`bet_rejected`/`cashout_rejected`):

| Code | Source | Meaning |
|---|---|---|
| `rate_limited` | gateway | > 15 msg/s on this socket. |
| `not_authenticated` | gateway | No/invalid session token for a money action. |
| `invalid_payload` | gateway | Payload failed schema (bad panel, non-finite/non-positive amount, `autoCashout ≤ 1`). |
| `betting_closed` | bets | `place_bet`/`cancel_bet` outside the `betting` phase. |
| `invalid_amount` | bets/risk | Stake below min or above max for the currency. |
| `already_bet` | bets | A bet already exists for this `(round, panel)`. |
| `insufficient_balance` | bets | Operator/ledger rejected the debit for funds. |
| `bet_failed` | bets | Generic bet failure (wallet resolution, exposure-lock contention, transient DB/activation error). |
| `round_exposure_cap` | bets/risk | The round's aggregate potential payout would exceed the operator exposure cap. |
| `reality_check_pending` | bets | RG: a reality check is awaiting `reality_check_ack` (enforce mode). |
| `session_time_limit` | bets | RG: session duration limit reached. |
| `session_loss_limit` | bets | RG: session loss cap would be exceeded. |
| `session_wager_limit` | bets | RG: session wager cap would be exceeded. |
| `no_active_bet` | bets | Cancel/cash-out with no active bet for that panel (or lost a claim race). |
| `too_late` | bets | Cash-out outside `running`, or at/after the (authoritative) crash. |

> `bet_failed` is intentionally generic to the client (no internal-state leak);
> internally distinct causes (`wallet_owner_mismatch`, exposure-lock contention,
> activation failure) are recorded as separate metrics. The seamless-wallet layer
> also raises internal categories `insufficient_balance`, `wallet_unavailable`
> (ambiguous timeout → compensated), `wallet_error`, and `payout_pending`
> (see §9) — these manifest to the client as the rows above.

**Bet void (`POST /api/operator/bets/:betId/void`, §13.3):**

| Code | HTTP | Meaning |
|---|---|---|
| `invalid betId` | **400** | `:betId` is not a UUID. |
| `bet_not_found` | **404** | The bet is unknown, is not in **your** operator scope, or is internal/guest play. Returned identically in all three cases (no cross-tenant existence oracle). |
| `bet_not_settled` | **409** | The bet is still `active` (live in the round) — settle it first, then void. |
| `bet_transient` | **409** | The bet is in a transient money state (`reserving` / `cancelling` / `payout_pending`) — retry the void once it settles. |
| `bet_state_changed` | **409** | The settle-state CAS lost a race (the bet changed under us) — safe to retry. |

> The void route is authenticated by the **reporting API key** (§13.1), so the
> launch/session and WebSocket error tables above do not apply to it; failures
> surface as the HTTP status + error string in this table.

---

## 13. Reporting, round history & provably-fair

### 13.1 Operator reporting API (B2B)

Source of truth: `src/operator/reporting.controller.ts`,
`src/operator/reporting.service.ts`, `src/operator/operator-auth.guard.ts`.

Authenticated by your **reporting API key**: `Authorization: Bearer
vrk_<operatorId>.<secret>`. Every route is hard-scoped to your `operatorId` (taken
only from the key, never from the query). Optional IP allow-list applies if
configured. Money is summed in minor units and returned as decimal **strings** (sums
can exceed 2^53); demo bets are excluded unless `includeDemo=true`.

| Route | Purpose |
|---|---|
| `GET /api/operator/reports/summary?from&to[&currency][&includeDemo]` | Per-currency totals: `betCount`, `wagered`, `won`, `ggr`, `uniquePlayers`, `rtp`, `decimals`. |
| `GET /api/operator/reports/daily?from&to[&currency][&includeDemo]` | The same, bucketed per UTC day. |
| `GET /api/operator/reports/bets?from&to[&currency][&includeDemo][&cursor][&limit]` | Paginated per-bet rows (id, roundId, playerId, currency, panel, amount, status, cashoutMult, payout, demo, timestamps) with `nextCursor`. |
| `GET /api/operator/reports/transaction?transactionId=…` (or `?betId=…`) | Single-transaction status lookup (§13.2) — the disposition of one money-move when a wallet response was lost. |
| `POST /api/operator/bets/:betId/void` | **Money-write** — fully reverse a settled bet so it is as if it never happened (refund the stake; reclaim the payout if it won). Idempotent, tenant-scoped (§13.3). |

Example `summary` response:

```json
{
  "operatorId": "11111111-1111-1111-1111-111111111111",
  "from": "2026-06-01T00:00:00.000Z",
  "to": "2026-06-07T00:00:00.000Z",
  "includeDemo": false,
  "currencies": [
    {
      "currency": "EUR", "decimals": 2, "betCount": 12840,
      "wagered": "1284000", "won": "1245480", "ggr": "38520",
      "uniquePlayers": 217, "rtp": "0.9700"
    }
  ]
}
```

### 13.2 Transaction status (single-transaction lookup)

Source of truth: `src/operator/reporting.controller.ts`, `src/operator/reporting.service.ts`.

Resolve **one** money-move to its current disposition — for when a `/bet` or `/win`
response was lost and you must learn the final outcome before deciding whether to
retry, refund, or reconcile.

`GET /api/operator/reports/transaction` (reporting-key auth, hard-scoped to your
`operatorId`). Provide **exactly one** of:

- `transactionId` — the idempotency key we sent on the wallet call (URL-encoded). One
  of: `bet:{roundId}:{userId}:{panel}:debit`, `bet:{betId}:payout`,
  `bet:{betId}:refund`, `bet:{betId}:restart_refund`.
- `betId` — our bet UUID (sent on every wallet call).

Success **200**:

```json
{
  "operatorId": "11111111-1111-1111-1111-111111111111",
  "betId": "f3a1…",
  "roundId": "r-2026-0001",
  "playerId": "player-42",
  "currency": "EUR",
  "decimals": 2,
  "panel": "A",
  "status": "cashed_out",
  "stake": "100",
  "payout": "200",
  "cashoutMult": "2.00",
  "debitState": "applied",
  "refundState": "none",
  "payoutState": "paid",
  "debitTxId": "op-987",
  "payoutTxId": "op-988",
  "demo": false,
  "createdAt": "2026-06-07T12:00:00.000Z",
  "settledAt": "2026-06-07T12:00:07.000Z",
  "query": { "transactionId": null, "betId": "f3a1…", "kind": "betId" }
}
```

**Read the disposition by the `*State` fields — never infer it from a single boolean.**

| Field | Value | Meaning |
|---|---|---|
| `debitState` | `pending` | The stake debit is **being reconciled** — it MAY already be applied on your wallet. Do **not** read this as "no charge"; the RGS will roll back any applied debit. (status `reserving`.) |
|  | `applied` | The stake was debited (status `active`/`cashed_out`/`busted`/`payout_pending`/`cancelling`). |
|  | `reversed` | The stake was debited and then fully **refunded** (status `cancelled`). |
| `refundState` | `none` / `pending` / `applied` | Refund not applicable / in flight / completed. |
| `payoutState` | `none` | No payout (lost, or no win). |
|  | `pending` | A win is **owed**; our credit is unconfirmed and MAY already be applied on your wallet. We retry the idempotent `/win` until confirmed — do **not** credit it yourself; dedup on the `transactionId`. (status `payout_pending`.) |
|  | `paid` | The payout was credited and confirmed (status `cashed_out`). |

> **Critical reading rules (avoid a double-credit / missed refund):**
> - `debitTxId` / `payoutTxId` are **best-effort references**. A `null` does **NOT** mean
>   "not applied" — reconcile by the `*State` fields and your own dedup on the
>   `transactionId`, never by the presence of our tx id.
> - A **`pending`** state means *unknown / being reconciled*, not *did not happen*.
> - **404** (`transaction_not_found`) means we hold no transaction in **your** operator
>   scope — it is **NOT** proof the money move didn't occur on your wallet. If your
>   wallet shows the charge/credit, trust your wallet and reconcile; never re-apply on a
>   404. (404 is returned identically for not-found, another operator's transaction, and
>   internal/guest play — no cross-tenant existence signal.)

### 13.3 Bet void / refund (operator-initiated)

Source of truth: `src/game/operator-bets.controller.ts`,
`src/game/bets.service.ts` (`voidBet` / `performVoidReversals`),
`src/wallet/operator-wallet.types.ts` (the `/rollback` contract).

Fully reverse a **settled** bet so it is as if it never happened: **refund the
stake**, and for a **won** bet ALSO **reclaim the payout** (the clawback). This is
the operator's correction/dispute tool (e.g. a confirmed fraud or platform error on
a single bet). It is **idempotent on the bet**, **tenant-scoped**, and **resumable**
(a reversal interrupted mid-flight is finished on retry — see the operator-facing
notes).

```http
POST /api/operator/bets/{betId}/void HTTP/1.1
Authorization: Bearer vrk_<operatorId>.<secret>
Content-Type: application/json

{ "reason": "chargeback #88213 — confirmed fraud" }
```

- **Auth.** The **reporting API key** (§13.1), `Authorization: Bearer
  vrk_<operatorId>.<secret>`. The route is **hard-scoped** to your `operatorId`
  (taken only from the key) and `voidBet` re-checks `bet.operatorId` — a bet that is
  not yours returns **404** `bet_not_found` (no cross-tenant existence oracle).
- **Path param.** `betId` — our bet UUID (the same `betId` we sent on every `/bet` /
  `/win` / `/rollback`). A non-UUID → **400** `invalid betId`.
- **Body.** `{ "reason"?: string }` — optional. Logged (audit trail) only; capped at
  **500 characters**, control characters are stripped and whitespace collapsed, a
  non-string is treated as absent. The body may be empty (`{}`).

#### Void rules (status → behaviour)

The action depends on the bet's current status. Only **settled** bets can be voided;
everything else is either an idempotent no-op or a retryable conflict.

| Bet status | Behaviour | Result |
|---|---|---|
| `busted` (lost) | Refund the stake. | **200**, `status:"voided"`, `reversed:true`. |
| `cashed_out` (won) | Reclaim the payout **first**, then refund the stake. | **200**, `status:"voided"`, `reversed:true`. |
| `active` (live in the round) | Not settled — settle it first. | **409** `bet_not_settled`. |
| `reserving` / `cancelling` / `payout_pending` | Transient money state — retry once settled. | **409** `bet_transient`. |
| `voided` | Already voided — idempotent no-op. | **200**, `status:"voided"`, `reversed:false`. |
| `cancelled` (player pre-settlement cancel) | Already net-zero (stake was refunded at cancel) — no-op. | **200**, `status:"cancelled"`, `reversed:false`. |
| not yours / not found / internal or guest | No such bet **in your scope**. | **404** `bet_not_found`. |
| (path) non-UUID `betId` | Malformed request. | **400** `invalid betId`. |
| (race) settle-state CAS lost a race | The bet changed under us — retry. | **409** `bet_state_changed`. |

> The reclaim of a won bet runs **before** the stake refund by design: if the
> operator rejects the clawback (see note 2), nothing has been refunded yet and the
> void aborts cleanly and is retryable — the player can never end up refunded-but-not-
> reclaimed.

#### Success response (`VoidResult`)

**200**:

```json
{
  "ok": true,
  "betId": "f3a1c2d4-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
  "status": "voided",
  "reversed": true,
  "refundedStake": "100",
  "reclaimedPayout": "245"
}
```

| Field | Meaning |
|---|---|
| `ok` | Always `true` on a 200 (failures are HTTP 4xx with an error string per §12). |
| `betId` | Echoes the path `betId`. |
| `status` | The bet's **final** status — `voided` (a settled bet was reversed, or a prior void replayed) or `cancelled` (a player-cancelled bet, already net-zero). |
| `reversed` | Did **this** call perform the reversal? `true` = this call moved money; `false` = the bet was already net-zero before this call (an idempotent replay of a `voided`/`cancelled` bet). Use this to distinguish a first void from a retry. |
| `refundedStake` | The bet's **lifetime** void outcome — minor units returned to the player (the stake). A **minor-unit string**. |
| `reclaimedPayout` | The bet's **lifetime** void outcome — minor units reclaimed from the player (the original payout; `"0"` if the bet never won). A **minor-unit string**. |

> `refundedStake` / `reclaimedPayout` describe the bet's **lifetime** void outcome,
> not necessarily what this specific call moved. On an idempotent replay
> (`reversed:false`) they still report the same figures (a re-voided won bet returns
> the original stake **and** payout). To know whether **this** call did the work,
> read `reversed`, not the money figures.

#### Operator-facing notes (read before enabling void)

These determine how a void interacts with **your** wallet and your books. They are
not optional reading — a wrong assumption here double-reverses money.

1. **A void is issued as `/rollback`s of the ORIGINAL transactions — not new
   `/bet`/`/win` calls.** In operator mode we reverse the bet by rolling back the
   exact `transactionId`s of the original moves:
   - the stake refund = `POST /rollback` with `transactionId =
     "bet:{roundId}:{userId}:{panel}:debit"` (the original `/bet`);
   - the payout reclaim = `POST /rollback` with `transactionId =
     "bet:{betId}:payout"` (the original `/win`).

   Because these are rollbacks of the original moves (not fresh debits/credits), a
   void **does not inflate turnover or GGR** — the original bet/win are simply undone
   on your statement. Your `/rollback` (§7.3) **MUST be idempotent BOTH ways**: a
   rollback of a `transactionId` you never applied is a no-op, **and** a **repeated**
   rollback of the **same** `transactionId` is a no-op returning the same
   authoritative balance. The RGS relies on repeat-rollback idempotency because a
   void interrupted between its reclaim and refund legs is **retried** (by the
   operator re-POSTing the void, and by our internal `voiding` finalizer sweep),
   re-issuing the same rollback. **A non-idempotent repeat-rollback would
   double-reverse the money.**

2. **The clawback's net effect is operator-defined.** The reclaim of a won payout is
   a rollback of the `win`; whether it is *allowed*, and what it does if the player
   has already spent the funds, is **your wallet's decision**. You may apply it
   (possibly taking the player's balance negative) or **reject** it. If you reject
   the reclaim, our `reverse` call propagates the failure: the void **aborts cleanly
   on our side** (nothing was refunded yet — the reclaim runs first), the bet is left
   in an internal `voiding` state, and the action is **retryable** (re-POST the void,
   or our finalizer sweep retries it) once you can honour the reclaim. A `409`
   `bet_transient` is *not* what a rejected clawback returns — a rejected clawback
   surfaces as the void not completing (the bet does not reach `voided`); poll
   `transaction status` (§13.2) / reporting to confirm.

3. **A voided bet is excluded from GGR / turnover** in the reporting API (§13.1) —
   it is treated as-if-never-happened. Its **transaction status** (§13.2) reflects
   the reversal: `debitState:"reversed"` (the stake was refunded) and
   `payoutState:"none"` (the payout, if any, was reclaimed). Reconcile (§10) sees the
   void net cleanly: the stake refund nets the original debit and the payout reclaim
   nets the original payout, both keyed `refType:"bet"` / `refId:betId`.

#### Activation prerequisites (REQUIRED before an operator is granted void access)

This is a **money-write** endpoint authenticated by the **reporting** key. Two
controls are **pending and required before** any operator is enabled with void
access — until they are in place, treat void as a privileged, secured operation:

- **Per-operator rate limit (pending / required).** Today only the **global per-IP**
  request throttle applies; there is **no per-operator rate limit** on this
  money-write route. A per-operator limit MUST be added before enabling void in
  production.
- **Read-vs-write key scope (pending / decision required).** The **same reporting
  key** that authorizes read-only reports (§13.1) currently **also authorizes this
  money write**. Until a separate **write-capability / dedicated write key** exists,
  **treat the reporting key as write-capable**: rotate and store it accordingly, and
  an **IP allow-list** (the reporting allow-list, §3) is **strongly recommended** for
  the void caller. A decision on splitting read vs write capability is required
  before activation.

### 13.4 Player read-only endpoints (session-token auth)

Source of truth: `src/wallet/wallet.controller.ts`.

| Route | Purpose |
|---|---|
| `GET /api/wallet/balance` | Returns `{ currency, balance }`. In operator mode this is **your authoritative balance** (via `/balance`), not our journal. |
| `GET /api/wallet/transactions` | Returns our **local journal** (last 50 ledger rows). In operator mode this is a reconciliation aid, **not** the player's authoritative statement (that lives at the operator). |

### 13.5 Round history (public)

`GET /api/rounds/history` (source: `src/game/rounds.controller.ts`) — the last 30
finished rounds: `[{ id, crashMult, endedAt }]`. `GET /api/round/current` returns the
current public round snapshot (no crash leak).

### 13.6 Provably-fair

Crash points are verifiable with zero trust in our server. Public endpoints:
`GET /api/fairness/current` (active chain commitment), `GET /api/fairness/round/:id`
(a finished round's revealed seed + salt + recomputed crash + chain-link check),
`GET /api/fairness/epochs`, `GET /api/fairness/epoch/:epoch/seeds`, and
`POST /api/fairness/verify` `{ seed, salt, prevSeed? }`. Full scheme and worked
example: `provably-fair-guide.md`.

---

## 14. Environments

The hosted operator-mode sandbox is **live** at `https://sandbox.vaultrun.app`; the
`*.vaultrun.example` hostnames below are placeholders for request examples — the
**wire contract is real and stable**.

| Environment | REST base | WS base | Status |
|---|---|---|---|
| Sandbox | `https://sandbox.vaultrun.app` | `wss://sandbox.vaultrun.app` | **Live** — hosted operator-mode sandbox (operator-wallet stub) for integration testing. **Not** under the production SLA (`commercial/sla.md` §9). |
| Production | `https://api.vaultrun.example` | `wss://api.vaultrun.example` | Live, but currently running **operator-mode OFF** (internal play-money demo). Hostname is a placeholder. |

> Important: production today runs with `WALLET_PROVIDER_TYPE=internal` (play-money,
> the public demo) — the operator seamless-wallet path is built, tested, and dormant.
> The hosted sandbox at `https://sandbox.vaultrun.app` exercises the **real** operator
> wallet contract end-to-end (against an operator-wallet stub); this spec's request and
> response shapes are stable and will not change. Do not hardcode the production
> hostname from this document.

---

## 15. Worked example: launch → bet → cash out → reconcile

Concrete, end-to-end. Placeholders for ids/secrets.

**(1) Operator mints a launch token** (server-side, signed with `launchSecret`):

```json
// JWT payload, HMAC-SHA256(launchSecret), exp = now+120s
{
  "operatorId": "11111111-1111-1111-1111-111111111111",
  "playerId": "player-42",
  "currency": "EUR",
  "demo": false,
  "jti": "9c1d2e3f-aaaa-bbbb-cccc-1234567890ab",
  "iat": 1750000000,
  "exp": 1750000120
}
```

**(2) Client opens the game:**

```http
POST /api/operator/launch HTTP/1.1
Content-Type: application/json

{ "token": "eyJhbGciOiJIUzI1Ni␣…launch JWT…" }
```
```json
200 OK
{
  "token": "eyJhbGciOiJIUzI1Ni␣…session token…",
  "sessionId": "b8c0…",
  "walletId": "c1d2…",
  "currency": "EUR",
  "decimals": 2,
  "locale": "en",
  "callbackUrl": "https://op.example/lobby"
}
```

**(3) Client connects WS** with `auth.token = "<session token>"`, receives
`round_state` (`phase:"betting"`).

**(4) Place a €1.00 bet on panel A with auto-cashout 2.00x:**

```js
socket.emit("place_bet", { panel: "A", amount: 100, autoCashout: 2.0 }, (ack) => {});
```

The RGS debits via your wallet:

```http
POST https://op.example/wallet/bet
Authorization: Bearer <walletApiKey>
Content-Type: application/json

{
  "playerId": "player-42",
  "currency": "EUR",
  "amount": "100",
  "transactionId": "bet:r-2026-0001:u-7:A:debit",
  "roundId": "r-2026-0001",
  "betId": "f3a1…"
}
```
```json
200 OK
{ "operatorTxId": "op-987", "balance": "9900" }
```

Client ack / event:

```json
// bet_accepted (ack of place_bet)
{ "ok": true, "panel": "A", "balance": 9900, "betId": "f3a1…", "currency": "EUR" }
// balance_updated
{ "currency": "EUR", "balance": 9900 }
```

**(5) Round runs, reaches 2.00x → auto cash-out fires.** The RGS credits the win
(`payout = floor(100 × 2.00) = 200`):

```http
POST https://op.example/wallet/win
Authorization: Bearer <walletApiKey>
Content-Type: application/json

{
  "playerId": "player-42",
  "currency": "EUR",
  "amount": "200",
  "transactionId": "bet:f3a1…:payout",
  "roundId": "r-2026-0001",
  "betId": "f3a1…"
}
```
```json
200 OK
{ "operatorTxId": "op-988", "balance": "10100" }
```

Client events:

```json
// cashout_accepted (auto)
{ "ok": true, "panel": "A", "multiplier": 2.0, "payout": 200, "auto": true, "pending": false }
// balance_updated
{ "currency": "EUR", "balance": 10100 }
```

**(6) Reconcile.** Your book for `betId f3a1…`: `bet = 100`, `win = 200`,
`rollback = 0`. Bet status in our reports = `cashed_out`, `payout = 200`. Checks:
win linkage (`win 200 == payout 200` ✓), stake linkage (`100 == amount 100` ✓),
conservation (`Σbet 100 − Σwin 200 − Σrollback 0 = −100` = `stake 100 − payout 200`
✓). Net player result: `+100` minor units (€1.00 profit on a €1.00 stake at 2.00x).

---

## 16. Summary / integration checklist

The crash point is fixed before betting closes and is independently verifiable
(`provably-fair-guide.md`); the math is currency-agnostic on integer minor units
(`game-math-spec.md`); money safety rests on **idempotent** wallet calls plus
ambiguity compensation (rollback on a timed-out debit, never-claw-back + reconcile on
a win).

> **Status:** the wire contract in this document (launch protocol, WebSocket
> protocol, seamless-wallet endpoints, money & idempotency semantics, error codes)
> is **implemented and stable** in the current code and validated by load + operator
> reconciliation soaks. Production currently runs **operator-mode OFF** (internal
> play-money demo); a **hosted operator-mode sandbox is live** at
> `https://sandbox.vaultrun.app` (operator-mode stub; integration-testing only — not
> under the production SLA), and the request/response shapes here will not change.
>
> **Scope note on latency.** The published **settlement p99 < 200 ms**
> (`commercial/sla.md` §3) measures **RGS-internal** settlement processing and
> **excludes the operator's wallet round-trip**; it was measured single-node (the
> ceiling was an application-level lock, not CPU) against a zero-latency wallet stub.
> An end-to-end SLO including the operator wallet RTT is defined against an agreed
> measurement point in a signed SLA.

**Operator integration checklist:**

- [ ] Receive `operatorId` + `launchSecret` (+ reporting key) from us; store secrets
      in your secret manager.
- [ ] Provide your `walletApiUrl`, `walletApiKey`, currency allow-list, per-currency
      `betLimits`, RG config, and return-to-lobby URL.
- [ ] Implement `POST /bet`, `/win`, `/rollback`, `/balance` (§7) with **Bearer
      auth** and **idempotency on `transactionId`** (§9).
- [ ] Map insufficient funds to `402`/`409`/`{error:"insufficient_funds"}`.
- [ ] Make `/rollback` idempotent and tolerant of a `transactionId` you never saw.
- [ ] Mint launch JWTs (HMAC-SHA256, your secret, unique `jti`, 120 s TTL).
- [ ] Call `POST /api/operator/launch`, then connect the WS with the returned session
      token; handle all server→client events (§6.2), including RG events.
- [ ] Render minor units using `GET /api/currencies` decimals.
- [ ] Wire reporting (`/api/operator/reports/*`) and reconcile on the §10 invariants
      (key your book by `betId`).
- [ ] Expose provably-fair verification to players (link `provably-fair-guide.md` /
      `/api/fairness/*`).
- [ ] Test end-to-end against the reference wallet (`load/operator-wallet-stub.ts`)
      and the live hosted sandbox (`https://sandbox.vaultrun.app`).
