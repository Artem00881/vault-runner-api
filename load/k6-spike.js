// k6 spike test — sudden surge of traffic, then back to baseline.
//
// Validates the API survives a fast jump in concurrent users (e.g. a streamer
// drops a link) without runaway errors/latency, and recovers afterwards. Same
// REST flow as k6-http.js, different load shape.
//
// Run: docker run --rm -e BASE_URL=http://host.docker.internal:3001 \
//        -v "$PWD/load:/load" grafana/k6 run /load/k6-spike.js
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:3001";
const PEAK = Number(__ENV.PEAK || 200);
const flowErrors = new Rate("flow_errors");

export const options = {
  scenarios: {
    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 10 }, // warm baseline
        { duration: "10s", target: PEAK }, // sharp spike up
        { duration: "30s", target: PEAK }, // hold the surge
        { duration: "10s", target: 10 }, // drop back
        { duration: "10s", target: 0 }, // recover
      ],
      gracefulRampDown: "5s",
    },
  },
  // Spikes tolerate a bit more latency than steady-state; errors must stay low.
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<500"],
    flow_errors: ["rate<0.02"],
  },
};

function ok(res, name) {
  const good = check(res, { [`${name} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
  flowErrors.add(!good);
  return good;
}

let vuToken = null;

export default function () {
  ok(http.get(`${BASE}/health`), "health");
  ok(http.get(`${BASE}/api/fairness/current`), "fairness");
  ok(http.get(`${BASE}/api/round/current`), "round");

  if (!vuToken) {
    const auth = http.post(`${BASE}/api/auth/guest`);
    if (ok(auth, "guest")) vuToken = auth.json("token");
  }
  if (vuToken) {
    ok(http.get(`${BASE}/api/wallet/balance`, { headers: { authorization: `Bearer ${vuToken}` } }), "balance");
  }

  sleep(0.5);
}
