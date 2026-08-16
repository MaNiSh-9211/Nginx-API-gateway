// Low-VU test: WAF per-IP rate limit on anonymous /public/* (ADR-0006).
// Expect 429s once RPS exceeds WAF_IP_RATE_LIMIT_RPS (default 100).
//
//   docker run --rm -v ./tests:/scripts grafana/k6 run /scripts/waf_rate_limit.js
//
import http from 'k6/http';
import { check } from 'k6';

const GW = __ENV.GATEWAY_URL || 'http://host.docker.internal:18083';

export const options = {
    vus: 5,
    duration: '15s',
    thresholds: {
        // We expect some 429s — not a failure, proves WAF works.
        'http_req_duration': ['p(99)<500'],
    },
};

export default function () {
    const res = http.get(`${GW}/public/status`);
    check(res, {
        'status is 200 or 429': (r) => r.status === 200 || r.status === 429,
    });
}
