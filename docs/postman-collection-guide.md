# Vault Run — Postman Collection Guide

**Version:** 1.0  ·  **Date:** 2026-06-07  ·  **Audience:** operator / aggregator integration engineers

This guide explains how to use the Vault Run RGS Postman artifacts to exercise the
seamless-wallet integration end to end. The authoritative protocol reference is
`api-integration-spec.md`; this guide is operational only. All money values are
**integer minor units** (e.g. `100` = €1.00 for EUR).

Files:

- `vaultrun-api.postman_collection.json` — the collection (Postman Collection Schema
  v2.1.0).
- `vaultrun-sandbox.postman_environment.json` — an environment of placeholder
  variables (no real secrets).

---

## 1. Import

1. In Postman: **Import** → drop in both JSON files.
2. Top-right environment selector → choose **"Vault Run — Sandbox"**.
3. Open the environment (the eye icon, or **Environments** in the sidebar) and set
   the values below.

You can also run the collection headlessly with
[Newman](https://www.npmjs.com/package/newman):

```
newman run vaultrun-api.postman_collection.json \
  -e vaultrun-sandbox.postman_environment.json \
  --folder "1. Operator — launch & session"
```

(Newman runs the HTTP folders 1–5; the Socket.IO folder 6 is documentation-only —
see §6.)

---

## 2. Set the variables

The environment ships with safe placeholders. Replace the ones we issue you; the
rest have working defaults.

| Variable | Set to | Notes |
|---|---|---|
| `baseUrl` | Your sandbox REST base | URL is TBD — we issue it. No trailing slash. |
| `wsUrl` | Your sandbox WS base | `wss://…`. Used for the Socket.IO handshake. |
| `operatorId` | Your operator UUID | Goes into the launch-token `operatorId` claim. |
| `launchSecret` | Your 32-byte hex HMAC secret | **Secret.** The pre-request script signs the launch JWT with this. |
| `currency` | `EUR` (or any allow-listed code) | Must be in your currency allow-list. |
| `playerId` | Your player id | e.g. `player-42`. |
| `reportingKey` | `vrk_<operatorId>.<secret>` | **Secret.** For the reporting folder. |
| `walletApiUrl` | Your wallet base URL | **Folder 5 calls this**, not the RGS. |
| `walletApiKey` | Your wallet Bearer key | **Secret.** Folder 5 auth. |
| `roundId`, `userId`, `betId` | Example ids | Build the wallet `transactionId`s in folder 5; defaults are fine for a smoke test. |
| `fairnessRoundId` | A finished round id | From `GET /api/rounds/history`. |
| `fairnessEpoch` | A fairness epoch number | From `GET /api/fairness/epochs`. |

`launchToken` and `sessionToken` are filled **automatically** (see §3/§4) — leave
them blank. Variables marked secret use Postman's masked `secret` type.

---

## 3. The launch-JWT pre-request script (how it works)

`POST /api/operator/launch` (folder 1) carries a **pre-request script** that mints a
signed launch token so you don't need a server to test. In production **you** mint
this server-side; the script just reproduces that signing exactly
(`src/operator/launch-token.service.ts`, spec §4).

What it does, using Postman's built-in **CryptoJS** (no external dependency):

1. Builds the JWT header `{"alg":"HS256","typ":"JWT"}` and a payload with
   `operatorId`, `playerId`, `currency` (read from the environment), `demo:false`, a
   freshly generated RFC-4122 **v4 `jti`** (one-time id), `iat = now`, and
   `exp = iat + 120` (the RGS `TTL_SECONDS` is 120 s).
2. **base64url**-encodes the header and payload JSON (standard base64, then
   `+`→`-`, `/`→`_`, strip `=` padding).
3. Computes `HMAC-SHA256(header.payload, launchSecret)` and base64url-encodes the
   raw signature **bytes** (it base64url-encodes the CryptoJS WordArray directly —
   not a hex string — so the signature is the correct 32-byte HMAC, exactly what the
   RGS verifies).
4. Joins `header.payload.signature` and stores it in `{{launchToken}}`; the request
   body sends `{ "token": "{{launchToken}}" }`.

Because `exp` is `now + 120`, the token is always fresh at send time, and because
the `jti` is regenerated on every run the one-time-use rule (spec §4) never trips on
a re-send. If you prefer, mint the JWT in your own backend and paste it into
`{{launchToken}}` — then disable the pre-request script.

> The `jti` is consumed only when the session is actually created, so a token
> rejected for `currency_not_allowed` / `demo_not_allowed` is not burned — fix the
> variable and re-send (spec §4).

---

## 4. Run order

1. **`POST /api/operator/launch`** — mints the launch JWT (pre-request) and, on
   `200`, its **test script** saves the response `token` (the session/play token)
   into `{{sessionToken}}`. Run this first.
2. **Folder 2 (player)** and **folder 1 `session/close`** — use `{{sessionToken}}`
   as `Authorization: Bearer`. Run after launch.
3. **Folder 3 (reporting)** — independent; uses `{{reportingKey}}`. Set a sensible
   `from`/`to` (ISO instant or `YYYY-MM-DD`).
4. **Folder 4 (public)** — no auth; runnable any time. Grab a `fairnessRoundId`
   from `GET /api/rounds/history` for the fairness round/verify requests.
5. **Folder 5 (your wallet)** — points at `{{walletApiUrl}}`, not the RGS (see §5).

If a player request returns `401`, your `{{sessionToken}}` is missing or expired —
re-run the launch request (session tokens default to a 4-hour TTL).

---

## 5. Folder 5 — testing YOUR wallet (important)

Folder 5 is the inverse direction: these requests target **`{{walletApiUrl}}`**
(your seamless-wallet endpoint), with `Authorization: Bearer {{walletApiKey}}`, and
reproduce the **exact** calls the RGS makes on every money move (spec §7). Use them
to confirm your implementation:

- **`/bet`** debits a stake → `{ operatorTxId, balance }`; insufficient funds →
  `402`/`409`/`{error:"insufficient_funds"}`.
- **`/win`** credits a payout → `{ operatorTxId, balance }`; never clawed back.
- **`/rollback`** undoes a named `transactionId` → `{ operatorTxId, balance }`;
  idempotent on its own effect; safe for an id you never saw.
- **`/balance`** reads the authoritative balance → `{ balance }` (no
  `operatorTxId`).

The bodies use the canonical `transactionId` formats (spec §9):

- Stake: `bet:{roundId}:{userId}:{panel}:debit`
- Payout: `bet:{betId}:payout`
- Cancel refund: `bet:{betId}:refund`

**Idempotency check:** send `/bet` twice with the same body — your wallet must
return the **same** result and debit **once**. Then `/rollback` with the stake's
`transactionId` must reverse it (and be a no-op on a second send). Each request has
a test script asserting the response has `operatorTxId` + `balance` (just `balance`
for `/balance`). The runnable reference implementation of this contract is
`load/operator-wallet-stub.ts`.

---

## 6. The Socket.IO game protocol (folder 6)

The live game runs over **Socket.IO**, not HTTP (spec §6). Postman's Socket.IO
request is a GUI feature that is **not part of the importable Collection v2.1 JSON
schema**, so the collection cannot ship a runnable Socket.IO request without
producing a non-importable file — folder 6 is therefore a documentation stub, and
the full setup lives here.

**Create the connection** in Postman: **New → Socket.IO** (not "WebSocket" — the
RGS speaks the Socket.IO protocol, which adds its own framing/handshake on top of
raw WebSocket).

1. **URL:** `{{wsUrl}}` (your `wss://…` base).
2. **Handshake auth:** open **Settings → Handshake** and add an auth/arg object:

   ```json
   { "token": "{{sessionToken}}" }
   ```

   This maps to the client code in the spec:

   ```js
   const socket = io("wss://sandbox.vaultrun.example", {
     auth: { token: "<session token from /api/operator/launch>" },
   });
   ```

   Guests may connect with **no token** — they receive read-only round events, but
   any money action returns `not_authenticated`.
3. **Connect.** A valid session token must still map to a **live** `GameSession`; a
   revoked/closed session is rejected at connect even if the JWT hasn't expired.

**Emit (client → server)** — register each event name in Postman's message
composer, set the payload to JSON, and Send. Every message returns a Socket.IO ack.

| Event | Payload | Ack |
|---|---|---|
| `subscribe_round` | _(none)_ | `{ ok:true }` + (re)emits `round_state` |
| `time_sync` | `{ "t0": 1750000000000 }` | `{ ok:true, t0, serverTime }` |
| `place_bet` | `{ "panel":"A", "amount":100, "autoCashout":2.0 }` | `BetResult` |
| `cancel_bet` | `{ "panel":"A" }` | `BetResult` |
| `cash_out` | `{ "panel":"A" }` | `CashoutResult` |
| `reality_check_ack` | _(none)_ | `{ ok:true }` |

`place_bet`: `panel` ∈ `"A"` (Quick Grab) | `"B"` (Big Heist); `amount` is a finite
positive number in minor units; `autoCashout` is optional and must be finite and
**> 1**. Panels A and B are two independent positions sharing ONE crash point.

`BetResult` (success): `{ ok:true, panel, balance, betId, currency }`. On failure:
`{ ok:false, reason, panel }`.

`CashoutResult` (success): `{ ok:true, userId, panel, multiplier, payout, balance,
currency, pending }`. `pending:true` (operator mode) means the win is recorded but
the operator credit isn't yet confirmed — no `balance` is included then.

**Listen (server → client)** — add these as listeners:

| Event | Payload | When |
|---|---|---|
| `round_state` | `{ roundId, phase, phaseEndsAt, multiplier, serverTime }` | Connect, `subscribe_round`, every phase change. `phase` ∈ waiting\|betting\|running\|crashed\|settling\|completed |
| `multiplier_update` | `{ roundId, multiplier, serverTime }` | ~Every 120 ms while running (cosmetic; never trusted for payout) |
| `bet_accepted` | `BetResult` (`ok:true`) | A `place_bet` succeeded |
| `bet_rejected` | result (`ok:false, reason`) | A `place_bet`/`cancel_bet` was rejected |
| `bet_cancelled` | `BetResult` (`ok:true`) | A `cancel_bet` refunded |
| `cashout_accepted` | `CashoutResult` (`ok:true`, may add `auto:true`) | A manual or auto cash-out paid |
| `cashout_rejected` | result (`ok:false, reason`) | A `cash_out` was rejected (e.g. `too_late`) |
| `bet_busted` | `{ panel }` | The round crashed with this bet still active |
| `round_crashed` | `{ roundId, crashMultiplier }` | At the crash (the point becomes public) |
| `round_settled` | `{ roundId }` | Settlement bookkeeping complete |
| `balance_updated` | `{ currency, balance }` | After any successful money move |
| `reality_check` | `{ elapsedSec, wagered, won, net, currency, enforce }` | Responsible gambling (spec §11) |
| `session_time_limit` | `{ maxSessionSec }` | RG: session duration limit reached |

**Limits:** one active socket per user (a second socket for the same user
disconnects the first); **15 messages/second** per socket (excess →
`{ ok:false, reason:"rate_limited" }`).

**Minimal happy path:** connect with `auth.token` → receive `round_state`
(`phase:"betting"`) → emit `place_bet {panel:"A", amount:100, autoCashout:2.0}` →
receive `bet_accepted` + `balance_updated` → watch `multiplier_update` → at 2.00x
the auto cash-out fires → receive `cashout_accepted {auto:true}` +
`balance_updated`. The full worked example (with the corresponding wallet `/bet` and
`/win` calls) is in `api-integration-spec.md` §15.

---

## 7. Error codes

The launch endpoint returns HTTP **400** (`invalid_body`) / **401** (token
failures: `invalid_launch_token`, `unknown_operator`, `currency_not_allowed`,
`demo_not_allowed`, `launch_token_already_used`, `operator_disabled`). WebSocket
rejections arrive in the ack `reason` (and `bet_rejected`/`cashout_rejected`):
`rate_limited`, `not_authenticated`, `invalid_payload`, `betting_closed`,
`invalid_amount`, `already_bet`, `insufficient_balance`, `bet_failed`,
`round_exposure_cap`, `reality_check_pending`, `session_time_limit`,
`session_loss_limit`, `session_wager_limit`, `no_active_bet`, `too_late`. Full
catalog: `api-integration-spec.md` §12.

---

## 8. Notes

- No real secrets or hostnames ship in these files — placeholders only. Do not
  commit real `launchSecret` / `walletApiKey` / `reportingKey` values into the
  environment; use Postman's secret vars and your own secret manager.
- The wire contract is stable; production currently runs operator-mode OFF (internal
  play-money demo) and the hosted operator-mode sandbox URL is TBD. Do not hardcode
  any hostname from these files (spec §14).
