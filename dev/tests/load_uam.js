// ============================================================
// k6 load test — UAM backend (Redis circuit-breaker overhead)
//
// Exercises /ready (breaker-protected Redis ping + Postgres) and
// /health. `/ready` is the key breaker-overhead probe: every call
// runs the local circuit breaker acquire/release + rolling-window
// histogram. Watch redis_latency_p99_us / uam_redis_* on /metrics
// while this runs.
//
//   ./scripts/load-test-uam.ps1
// ============================================================
import http from 'k6/http';
import { check, sleep } from 'k6';

const UAM = __ENV.UAM_URL || 'http://host.docker.internal:18080';

export const options = {
    stages: [
        { duration: '20s', target: 50 },
        { duration: '40s', target: 50 },
        { duration: '20s', target: 0 },
    ],
    thresholds: {
        // /ready includes a Postgres ping (remote Aiven in dev), so keep
        // p99 looser than the gateway hot-path test.
        http_req_duration: ['p(99)<500'],
        http_req_failed:   ['rate<0.01'],
    },
};

export default function () {
    const ready = http.get(`${UAM}/ready`);
    check(ready, { '/ready 200': (r) => r.status === 200 });

    const health = http.get(`${UAM}/health`);
    check(health, { '/health 200': (r) => r.status === 200 });

    sleep(0.01);
}