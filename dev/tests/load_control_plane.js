// ============================================================
// k6 load test — Control plane (ArcSwap config + Redis breaker)
//
// Exercises GET /config (ArcSwap hot path, no Redis) and /health
// (Redis circuit-state read + Postgres ping). /health is the key
// breaker-overhead probe: it reads the local circuit state and, via
// Prometheus /metrics aggregation, the rolling-window histogram.
//
//   ./scripts/load-test-control-plane.ps1
// ============================================================
import http from 'k6/http';
import { check, sleep } from 'k6';

const CP = __ENV.CONTROL_PLANE_URL || 'http://host.docker.internal:18085';
const TOKEN = __ENV.CONFIG_READ_TOKEN || 'uam_dev_config_read_token_change_me';

export const options = {
    stages: [
        { duration: '20s', target: 100 },
        { duration: '40s', target: 100 },
        { duration: '20s', target: 0 },
    ],
    thresholds: {
        // /health includes a Postgres ping (remote Aiven in dev).
        http_req_duration: ['p(99)<500'],
        http_req_failed:   ['rate<0.01'],
    },
};

export default function () {
    const cfg = http.get(`${CP}/config`, {
        headers: { 'X-Config-Read-Token': TOKEN },
    });
    check(cfg, { '/config 200': (r) => r.status === 200 });

    const health = http.get(`${CP}/health`);
    check(health, { '/health 200': (r) => r.status === 200 });

    sleep(0.01);
}