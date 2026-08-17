// ============================================================
// k6 load test — Redis circuit-breaker OUTAGE scenario (UAM)
//
// Single script, three phases selected by PHASE:
//   baseline : Redis healthy — /ready must return 200 (fast)
//   outage   : Redis paused by the orchestrator — breaker MUST reject
//              traffic fast (503s, no hangs), p99 stays bounded
//   recovery : Redis restored — /ready returns 200 again (fast)
//
// The invariant across ALL phases: requests never hang. The breaker's
// operation deadline + OPEN fast-fail guarantee this; if p(99) blows
// past 1500ms the run FAILS, proving the breaker is doing its job.
//
//   ./scripts/breaker-outage-loadtest.ps1
// ============================================================
import http from 'k6/http';
import { check, sleep } from 'k6';

const UAM = __ENV.UAM_URL || 'http://host.docker.internal:18080';
const PHASE = __ENV.PHASE || 'baseline';

export const options = {
    vus: 50,
    duration: '30s',
    // Force the percentiles into the --summary-export file (k6 only exports
    // percentiles listed here; the orchestrator parses p(99) for reporting).
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    thresholds: {
        // Fail-fast invariant: even mid-outage, requests must not hang.
        http_req_duration: ['p(99)<1500'],
        // baseline/recovery: ~no failures. outage: breaker MUST reject,
        // so the failure rate must be HIGH (not hangs — those also fail,
        // which is why the latency bound above is the real assertion).
        http_req_failed: [PHASE === 'outage' ? 'rate>0.9' : 'rate<0.01'],
    },
};

export default function () {
    // /ready runs the full breaker path (acquire -> redis ping -> release)
    // plus a Postgres ping. 503 = breaker rejected (OPEN) or redis degraded.
    const r = http.get(`${UAM}/ready`);
    check(r, {
        '/ready responds fast (200 or 503)': (res) => res.status === 200 || res.status === 503,
    });
    sleep(0.01);
}