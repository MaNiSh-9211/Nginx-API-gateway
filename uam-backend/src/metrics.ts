import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import {
    redisCircuitBreaker,
    STATE_VALUE,
} from './config/redisCircuitBreaker';

export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'uam_' });

export const httpRequestsTotal = new client.Counter({
    name: 'uam_http_requests_total',
    help: 'Total HTTP requests handled by UAM backend',
    labelNames: ['method', 'route', 'status'],
    registers: [register],
});

export const httpRequestDuration = new client.Histogram({
    name: 'uam_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
});

// ── Redis dependency health + circuit-breaker metrics (§22) ──────────────────
// Values are copied from the local circuit breaker at scrape time. The `*_total`
// series are cumulative (monotonic) so Prometheus `rate()` works as expected.
// No high-cardinality labels (no user/request/trace ids).

const redisCounter = (name: string, help: string): client.Gauge =>
    new client.Gauge({ name, help, registers: [register] });

export const redisRequestsTotal = redisCounter(
    'uam_redis_requests_total',
    'Total Redis operations attempted (breaker-protected)',
);
export const redisSuccessTotal = redisCounter(
    'uam_redis_success_total',
    'Successful Redis operations',
);
export const redisErrorsTotal = redisCounter(
    'uam_redis_errors_total',
    'Redis operation errors (excludes timeouts)',
);
export const redisTimeoutsTotal = redisCounter(
    'uam_redis_timeouts_total',
    'Redis operation timeouts',
);
export const redisCircuitOpenTotal = redisCounter(
    'uam_redis_circuit_open_total',
    'Times the Redis circuit transitioned to OPEN',
);
export const redisCircuitHalfOpenTotal = redisCounter(
    'uam_redis_circuit_half_open_total',
    'Times the Redis circuit transitioned to HALF_OPEN',
);
export const redisCircuitRejectedTotal = redisCounter(
    'uam_redis_circuit_rejected_total',
    'Requests rejected because the circuit was OPEN or the concurrency limit was hit',
);
export const redisCircuitState = redisCounter(
    'uam_redis_circuit_state',
    'Redis circuit state (0=CLOSED,1=OPEN,2=HALF_OPEN)',
);
export const redisInflightCurrent = redisCounter(
    'uam_redis_inflight_current',
    'Current Redis operations in flight',
);
export const redisLatencyP99Us = redisCounter(
    'uam_redis_latency_p99_us',
    'Rolling p99 Redis latency in microseconds',
);
export const redisErrorRateRolling = redisCounter(
    'uam_redis_error_rate_rolling',
    'Rolling Redis error rate (0.0-1.0)',
);

/** Copy live breaker state into the exported metrics before a scrape. */
export function refreshRedisCircuitMetrics(): void {
    redisRequestsTotal.set(redisCircuitBreaker.requestsTotal);
    redisSuccessTotal.set(redisCircuitBreaker.successTotal);
    redisErrorsTotal.set(redisCircuitBreaker.errorsTotal);
    redisTimeoutsTotal.set(redisCircuitBreaker.timeoutsTotal);
    redisCircuitOpenTotal.set(redisCircuitBreaker.circuitOpenTotal);
    redisCircuitHalfOpenTotal.set(redisCircuitBreaker.circuitHalfOpenTotal);
    redisCircuitRejectedTotal.set(redisCircuitBreaker.circuitRejectedTotal);
    redisCircuitState.set(STATE_VALUE[redisCircuitBreaker.currentState()]);
    redisInflightCurrent.set(redisCircuitBreaker.inflightCount());
    redisLatencyP99Us.set(redisCircuitBreaker.p99Us());
    redisErrorRateRolling.set(redisCircuitBreaker.errorRate());
}

/** Collapse dynamic path segments to keep Prometheus cardinality bounded. */
export function normalizeRoute(req: Request): string {
    if (req.route?.path) {
        const base = req.baseUrl || '';
        return `${base}${req.route.path}`;
    }
    const normalized = req.path
        .replace(/\/[0-9a-f]{24}/gi, '/:id')
        .replace(/\/[0-9a-f-]{36}/gi, '/:id');
    const parts = normalized.split('/').filter(Boolean).slice(0, 4);
    return parts.length ? `/${parts.join('/')}` : '/';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const route = normalizeRoute(req);
        httpRequestsTotal.inc({
            method: req.method,
            route,
            status: String(res.statusCode),
        });
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        httpRequestDuration.observe({ method: req.method, route }, seconds);
    });
    next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
    refreshRedisCircuitMetrics();
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
}
