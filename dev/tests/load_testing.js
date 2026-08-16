// ============================================================
// k6 load test — Ultra-Scale API Gateway (full, ~2 min)
//
// Exercises the authenticated hot path at up to 500 VUs. See ADR-0029 and
// docs/PERFORMANCE.md for why anonymous /public traffic is not load-tested
// from a single IP (WAF per-IP limit, ADR-0006).
//
//   ./scripts/load-test.ps1
// ============================================================
import http from 'k6/http';
import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

const GW = __ENV.GATEWAY_URL || 'http://host.docker.internal:18083';
const SECRET = __ENV.JWT_SECRET || 'super_secret_key_for_hmac_sha256_change_in_prod';

export const options = {
    stages: [
        { duration: '30s', target: 500 },
        { duration: '1m',  target: 500 },
        { duration: '30s', target: 0 },
    ],
    thresholds: {
        // Reference stack (Docker Desktop, single node): includes upstream + NAT.
        // Bare-metal / K8s fleets should target lower p99 — tune per environment.
        http_req_duration: ['p(99)<300'],
        http_req_failed:   ['rate<0.01'],
    },
};

function b64url(bytes) {
    return encoding.b64encode(bytes, 'rawurl');
}

function mintJwt(sub, region) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
        sub, home_region: region, iat: now, exp: now + 3600,
        iss: 'api-gateway-auth-server', aud: 'api-gateway-clients',
    }));
    const signingInput = `${header}.${payload}`;
    const sig = crypto.hmac('sha256', SECRET, signingInput, 'base64rawurl');
    return `Bearer ${signingInput}.${sig}`;
}

export function setup() {
    const token = mintJwt('load-user', 'US');
    const pub = http.get(`${GW}/public/status`);
    check(pub, { 'setup: public route reachable': (r) => r.status === 200 });
    return { token };
}

export default function (data) {
    const res = http.get(`${GW}/api/v1/orders`, {
        headers: { Authorization: data.token },
    });
    check(res, { 'authed 200': (r) => r.status === 200 });
    sleep(0.01);
}
