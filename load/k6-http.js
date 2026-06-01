// k6 HTTP load test — REST surface of the Vault Run API.
//
// Exercises the public reads + the guest-auth write path + an authed read, the
// way a lobby/client hits the API around the (WebSocket) game loop. The hot
// bet/cash-out path is Socket.IO and is NOT covered here — load-test that with
// `bun scripts/load-test.ts` (a Socket.IO client). See load/README.md.
//
// Run (Docker, no install):
//   docker run --rm -e BASE_URL=http://host.docker.internal:3001 \
//     -v "$PWD/load:/load" grafana/k6 run /load/k6-http.js
// Run (local k6):  BASE_URL=http://localhost:3001 k6 run load/k6-http.js
//
// Tunables via env: VUS (peak virtual users), RAMP, HOLD durations.
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3001";
const VUS = Number(__ENV.VUS || 50);
const flowErrors = new Rate("flow_errors");

export const options = {
  scenarios: {
    ramp: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || "15s", target: VUS },
        { duration: __ENV.HOLD || "30s", target: VUS },
        { duration: "10s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  // SLA-ish gates: <1% HTTP errors, read latency p95<200ms / p99<500ms.
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<200", "p(99)<500"],
    flow_errors: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

function ok(res, name) {
  const good = check(res, {
    [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  flowErrors.add(!good);
  return good;
}

// Per-VU cached token: authenticate once per virtual user, not every iteration
// (so a run creates ~VUS guest players, not one per request).
let vuToken = null;

export default function () {
  // Public reads — no auth.
  ok(http.get(`${BASE}/health`), "health");
  ok(http.get(`${BASE}/api/fairness/current`), "fairness");
  ok(http.get(`${BASE}/api/round/current`), "round");
  ok(http.get(`${BASE}/api/leaderboard`), "leaderboard");

  // Guest auth (DB write path) once per VU.
  if (!vuToken) {
    const auth = http.post(`${BASE}/api/auth/guest`);
    if (ok(auth, "guest")) vuToken = auth.json("token");
  }

  // Authed read.
  if (vuToken) {
    ok(
      http.get(`${BASE}/api/wallet/balance`, {
        headers: { authorization: `Bearer ${vuToken}` },
      }),
      "balance",
    );
  }

  sleep(1);
}
