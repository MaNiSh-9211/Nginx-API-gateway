// ============================================================
// k6 smoke load test — fast CI / dev validation (~30 s)
//
// Throughput is measured on the **authenticated** path only. Anonymous
// /public/* requests share a per-IP WAF limit (ADR-0006); hammering them
// from one k6 client IP would trip 429s and distort throughput numbers.
//
//   ./scripts/load-test.ps1 -Smoke
// ============================================================
import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

const GW = __ENV.GATEWAY_URL || 'http://host.docker.internal:18083';
const SECRET = __ENV.JWT_SECRET || 'super_secret_key_for_hmac_sha256_change_in_prod';

export const options = {
    stages: [
        { duration: '10s', target: 50 },
        { duration: '15s', target: 50 },
        { duration: '5s',  target: 0 },
    ],
    thresholds: {
        http_req_duration: ['p(99)<200'],
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
    const token = mintJwt('smoke-user', 'EU');
    // Sanity-check public route once (not part of throughput measurement).
    const pub = http.get(`${GW}/public/status`);
    check(pub, { 'setup: public route reachable': (r) => r.status === 200 });
    return { token };
}

export default function (data) {
    const res = http.get(`${GW}/api/v1/orders`, {
        headers: { Authorization: data.token },
    });
    check(res, { 'authed 200': (r) => r.status === 200 });
}
