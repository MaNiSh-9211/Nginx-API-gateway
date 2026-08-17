/**
 * Redis Circuit Breaker + Dependency Health Monitor (UAM backend)
 *
 * Architecture (per requirements.md §2):
 *
 *   Redis operation
 *         |
 *         v
 *   operation timeout / concurrency protection
 *         |
 *         v
 *   Health Recorder  --> latency histogram (time-bucketed rolling window)
 *         |          --> error counter
 *         |          --> timeout counter
 *         |          --> consecutive failure counter
 *         v
 *   Health Evaluator
 *     +- Fast detector:        consecutive failures >= threshold -> OPEN
 *     +- Statistical detector: rolling error rate / timeout rate / p99 >= threshold -> OPEN
 *         |
 *         v
 *   Circuit Breaker  (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)
 *         |
 *         v
 *   Degradation policy (callers decide: fail-open, fail-closed, memory fallback)
 *
 * Design decisions (requirements.md §4, §27):
 *   - Process-local only. No Redis, no network for circuit state.
 *   - Separate concepts: Metrics != Health evaluator != Circuit breaker != Policy.
 *   - Rolling latency: one-second time buckets; p50/p95/p99 computed on demand (§6).
 *   - Two detection mechanisms: fast (consecutive) + statistical (rolling) (§11).
 *   - Hysteresis: separate OPEN vs RECOVERY thresholds (§12).
 *   - Recovery jitter: randomized cooldown within [base, base + jitter] (§20, §21).
 *   - Minimum sample size before statistical decisions (§10).
 *   - HALF_OPEN: only N probe requests allowed; others skip Redis (§18, §19).
 *   - JS is single-threaded; state updates are plain fields (no atomics needed),
 *     but async interleaving is respected via explicit inflight accounting.
 *
 * Operation result taxonomy (requirements.md §25):
 *   SUCCESS              - Redis responded correctly
 *   REDIS_ERROR          - Redis returned a protocol/command error
 *   TIMEOUT              - I/O or connect deadline exceeded
 *   CIRCUIT_OPEN         - circuit prevented the call (fast rejection)
 *   CONCURRENCY_REJECTED - too many Redis ops in flight (back-pressure)
 *
 * Retry behavior (§16): command retries are owned by ioredis (bounded,
 * `REDIS_MAX_RETRIES_PER_REQUEST`, exponential backoff capped at 5s, reconnect
 * attempts capped by `REDIS_MAX_RECONNECT_ATTEMPTS`). The breaker itself never
 * retries; it re-allows probes after the cooldown.
 *
 * Known limitations / future work:
 *   - §13 baseline-aware (relative) latency detection is NOT implemented;
 *     absolute thresholds are used. Relative degradation is a future improvement.
 *   - §24 distributed tracing (OpenTelemetry spans) is NOT implemented yet. When
 *     the circuit is OPEN no fake Redis span is created; the planned LGTM stack
 *     should record a circuit-open event instead.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

import { otelLog } from '../otel';
export type RedisCallOutcome =
    | 'SUCCESS'
    | 'REDIS_ERROR'
    | 'TIMEOUT'
    | 'CIRCUIT_OPEN'
    | 'CONCURRENCY_REJECTED';

export const STATE_VALUE: Record<CircuitState, number> = {
    CLOSED: 0,
    OPEN: 1,
    HALF_OPEN: 2,
};

export interface CircuitBreakerConfig {
    /** Rolling window duration in seconds (= number of time buckets). */
    windowSecs: number;
    /** Minimum observations before the statistical detector activates. */
    minSamples: number;
    /** Consecutive failure threshold -> fast OPEN. */
    consecutiveFailOpen: number;
    /** Consecutive timeout threshold -> fast OPEN. */
    consecutiveTimeoutOpen: number;
    /** Error rate threshold [0, 1] -> statistical OPEN. */
    errorRateOpen: number;
    /** Timeout rate threshold [0, 1] -> statistical OPEN. */
    timeoutRateOpen: number;
    /** p99 latency threshold in microseconds -> statistical OPEN. */
    p99UsOpen: number;
    /** p99 latency threshold for RECOVERY (must be lower than the open threshold). */
    p99UsRecovery: number;
    /** Error rate threshold for RECOVERY (must be lower than the open threshold). */
    errorRateRecovery: number;
    /** Base cooldown before OPEN -> HALF_OPEN (ms). */
    openCooldownMs: number;
    /** Max jitter added to cooldown (ms). Prevents fleet recovery storms. */
    cooldownJitterMs: number;
    /** Number of probe requests allowed in HALF_OPEN before a decision. */
    halfOpenProbes: number;
    /** Consecutive successes in HALF_OPEN needed to move to CLOSED. */
    recoverySuccesses: number;
    /** Max Redis operations in flight (concurrency protection). */
    maxInflight: number;
    /** Max time HALF_OPEN may keep probing before re-arming OPEN (ms).
     * Prevents a stuck HALF_OPEN wedge when probes succeed but recovery
     * thresholds are not met (§18/§19). */
    halfOpenMaxMs: number;
    /** Breaker-level deadline for a single Redis operation (ms). If `fn` does
     * not settle within this budget, the operation is treated as a TIMEOUT so
     * inflight slots can never leak and the circuit keeps its health signal
     * (§14). */
    operationTimeoutMs: number;
}

export const defaultCircuitBreakerConfig = (): CircuitBreakerConfig => ({
    windowSecs: intEnv('REDIS_CB_WINDOW_SECS', 10),
    minSamples: intEnv('REDIS_CB_MIN_SAMPLES', 20),
    consecutiveFailOpen: intEnv('REDIS_CB_CONSECUTIVE_FAIL_OPEN', 5),
    consecutiveTimeoutOpen: intEnv('REDIS_CB_CONSECUTIVE_TIMEOUT_OPEN', 3),
    errorRateOpen: floatEnv('REDIS_CB_ERROR_RATE_OPEN', 0.5),
    timeoutRateOpen: floatEnv('REDIS_CB_TIMEOUT_RATE_OPEN', 0.4),
    p99UsOpen: intEnv('REDIS_CB_P99_US_OPEN', 250_000),
    p99UsRecovery: floatEnv('REDIS_CB_P99_US_RECOVERY', 50_000),
    errorRateRecovery: floatEnv('REDIS_CB_ERROR_RATE_RECOVERY', 0.1),
    openCooldownMs: intEnv('REDIS_CB_OPEN_COOLDOWN_MS', 5_000),
    cooldownJitterMs: intEnv('REDIS_CB_COOLDOWN_JITTER_MS', 2_000),
    halfOpenProbes: intEnv('REDIS_CB_HALF_OPEN_PROBES', 3),
    recoverySuccesses: intEnv('REDIS_CB_RECOVERY_SUCCESSES', 3),
    maxInflight: intEnv('REDIS_CB_MAX_INFLIGHT', 32),
    halfOpenMaxMs: intEnv('REDIS_CB_HALF_OPEN_MAX_MS', 10_000),
    operationTimeoutMs: intEnv('REDIS_CB_OPERATION_TIMEOUT_MS', 5_000),
});

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

function floatEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
}

/** Clamp into the same safe ranges the Rust gateway uses, then enforce
 * cross-field invariants (§12). */
function clampConfig(c: CircuitBreakerConfig): CircuitBreakerConfig {
    const clamped: CircuitBreakerConfig = {
        ...c,
        windowSecs: Math.min(60, Math.max(1, c.windowSecs)),
        minSamples: Math.min(1_000, Math.max(5, c.minSamples)),
        consecutiveFailOpen: Math.min(100, Math.max(1, c.consecutiveFailOpen)),
        consecutiveTimeoutOpen: Math.min(100, Math.max(1, c.consecutiveTimeoutOpen)),
        errorRateOpen: Math.min(1, Math.max(0, c.errorRateOpen)),
        timeoutRateOpen: Math.min(1, Math.max(0, c.timeoutRateOpen)),
        p99UsOpen: Math.min(60_000_000, Math.max(1_000, c.p99UsOpen)),
        p99UsRecovery: Math.min(60_000_000, Math.max(1_000, c.p99UsRecovery)),
        errorRateRecovery: Math.min(1, Math.max(0, c.errorRateRecovery)),
        openCooldownMs: Math.min(300_000, Math.max(100, c.openCooldownMs)),
        cooldownJitterMs: Math.min(60_000, Math.max(0, c.cooldownJitterMs)),
        halfOpenProbes: Math.min(20, Math.max(1, c.halfOpenProbes)),
        recoverySuccesses: Math.min(20, Math.max(1, c.recoverySuccesses)),
        maxInflight: Math.min(10_000, Math.max(1, c.maxInflight)),
        halfOpenMaxMs: Math.min(600_000, Math.max(1_000, c.halfOpenMaxMs)),
        operationTimeoutMs: Math.min(60_000, Math.max(100, c.operationTimeoutMs)),
    };
    // §12 — recovery_successes > half_open_probes would make recovery
    // impossible; clamp it (with a warning) instead of silently breaking.
    if (clamped.recoverySuccesses > clamped.halfOpenProbes) {
        process.stderr.write(
            `[redis_cb] WARN: REDIS_CB_RECOVERY_SUCCESSES (${clamped.recoverySuccesses}) ` +
            `> REDIS_CB_HALF_OPEN_PROBES (${clamped.halfOpenProbes}); recovery would be ` +
            `impossible — clamping to ${clamped.halfOpenProbes}\n`,
        );
        clamped.recoverySuccesses = clamped.halfOpenProbes;
    }
    if (clamped.p99UsRecovery >= clamped.p99UsOpen) {
        process.stderr.write(
            `[redis_cb] WARN: p99 recovery threshold (${clamped.p99UsRecovery}us) >= open ` +
            `threshold (${clamped.p99UsOpen}us); hysteresis disabled — set ` +
            `REDIS_CB_P99_US_RECOVERY below REDIS_CB_P99_US_OPEN\n`,
        );
    }
    if (clamped.errorRateRecovery >= clamped.errorRateOpen) {
        process.stderr.write(
            `[redis_cb] WARN: error-rate recovery threshold (${clamped.errorRateRecovery}) ` +
            `>= open threshold (${clamped.errorRateOpen}); hysteresis disabled — set ` +
            `REDIS_CB_ERROR_RATE_RECOVERY below REDIS_CB_ERROR_RATE_OPEN\n`,
        );
    }
    return clamped;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Rolling latency histogram (time-bucketed, memory-bounded)
// ─────────────────────────────────────────────────────────────────────────────

const HIST_BANDS = 18;

/** Upper bound (us) for each band. The last band is open-ended. */
const HIST_BOUNDS_US = [
    500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000,
    100_000, 150_000, 200_000, 300_000, 400_000, 500_000,
    750_000, 1_000_000, 2_000_000,
];

const MAX_WINDOW_BUCKETS = 64;

interface TimeBucket {
    ts: number;
    total: number;
    errors: number;
    timeouts: number;
    latencySum: number;
    hist: number[];
}

interface WindowStats {
    total: number;
    errors: number;
    timeouts: number;
    hist: number[];
}

class RollingWindow {
    private readonly buckets: TimeBucket[];

    constructor(size: number) {
        const n = Math.min(MAX_WINDOW_BUCKETS, Math.max(1, size));
        this.buckets = Array.from({ length: n }, () => ({
            ts: 0,
            total: 0,
            errors: 0,
            timeouts: 0,
            latencySum: 0,
            hist: new Array(HIST_BANDS).fill(0),
        }));
    }

    private static nowSecs(): number {
        return Math.floor(Date.now() / 1000);
    }

    record(outcome: RedisCallOutcome, latencyUs: number): void {
        const ts = RollingWindow.nowSecs();
        const b = this.buckets[ts % this.buckets.length];

        if (b.ts !== ts) {
            b.ts = ts;
            b.total = 0;
            b.errors = 0;
            b.timeouts = 0;
            b.latencySum = 0;
            b.hist.fill(0);
        }

        b.total += 1;
        b.latencySum += latencyUs;

        let band = HIST_BANDS - 1;
        for (let i = 0; i < HIST_BOUNDS_US.length; i += 1) {
            if (latencyUs <= HIST_BOUNDS_US[i]) {
                band = i;
                break;
            }
        }
        b.hist[band] += 1;

        if (outcome === 'REDIS_ERROR') {
            b.errors += 1;
        } else if (outcome === 'TIMEOUT') {
            // §8 — timeouts are tracked separately from general errors so the
            // error-rate and timeout-rate health signals stay independent.
            b.timeouts += 1;
        }
    }

    aggregate(windowSecs: number): WindowStats {
        const nowTs = RollingWindow.nowSecs();
        const cutoff = nowTs - windowSecs;

        const stats: WindowStats = {
            total: 0,
            errors: 0,
            timeouts: 0,
            hist: new Array(HIST_BANDS).fill(0),
        };

        for (const b of this.buckets) {
            if (b.ts < cutoff || b.ts > nowTs) continue;
            stats.total += b.total;
            stats.errors += b.errors;
            stats.timeouts += b.timeouts;
            for (let i = 0; i < HIST_BANDS; i += 1) {
                stats.hist[i] += b.hist[i];
            }
        }
        return stats;
    }

    reset(): void {
        for (const b of this.buckets) {
            b.ts = 0;
            b.total = 0;
            b.errors = 0;
            b.timeouts = 0;
            b.latencySum = 0;
            b.hist.fill(0);
        }
    }
}

function errorRate(stats: WindowStats): number {
    return stats.total === 0 ? 0 : stats.errors / stats.total;
}

function timeoutRate(stats: WindowStats): number {
    return stats.total === 0 ? 0 : stats.timeouts / stats.total;
}

/** Nth percentile latency in microseconds from a histogram. */
function percentileUs(stats: WindowStats, pct: number): number {
    if (stats.total === 0) return 0;
    const target = Math.ceil(stats.total * pct / 100);
    let cumulative = 0;
    for (let i = 0; i < HIST_BANDS; i += 1) {
        cumulative += stats.hist[i];
        if (cumulative >= target) {
            return i < HIST_BOUNDS_US.length ? HIST_BOUNDS_US[i] : Number.MAX_SAFE_INTEGER;
        }
    }
    return Number.MAX_SAFE_INTEGER;
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker
// ─────────────────────────────────────────────────────────────────────────────

export class CircuitBreaker {
    readonly config: CircuitBreakerConfig;
    private state: CircuitState = 'CLOSED';
    private openedAtMs = 0;
    private cooldownMs = 0;
    private consecutiveFail = 0;
    private consecutiveTimeout = 0;
    private probesDispatched = 0;
    private halfOpenSuccesses = 0;
    private halfOpenStartedAtMs = 0;
    private inflight = 0;
    private readonly window: RollingWindow;

    // Prometheus-visible counters
    public requestsTotal = 0;
    public successTotal = 0;
    public errorsTotal = 0;
    public timeoutsTotal = 0;
    public circuitOpenTotal = 0;
    public circuitHalfOpenTotal = 0;
    public circuitRejectedTotal = 0;

    constructor(config: CircuitBreakerConfig) {
        this.config = clampConfig(config);
        this.window = new RollingWindow(this.config.windowSecs);
    }

    currentState(): CircuitState {
        return this.state;
    }

    isClosed(): boolean {
        return this.state === 'CLOSED';
    }

    inflightCount(): number {
        return this.inflight;
    }

    /** p50 latency in microseconds from the rolling window (for metrics). */
    p50Us(): number {
        const stats = this.window.aggregate(this.config.windowSecs);
        return percentileUs(stats, 50);
    }

    /** p95 latency in microseconds from the rolling window (for metrics). */
    p95Us(): number {
        const stats = this.window.aggregate(this.config.windowSecs);
        return percentileUs(stats, 95);
    }

    /** p99 latency in microseconds from the rolling window (for metrics). */
    p99Us(): number {
        const stats = this.window.aggregate(this.config.windowSecs);
        return percentileUs(stats, 99);
    }

    /** Rolling error rate (for metrics). */
    errorRate(): number {
        const stats = this.window.aggregate(this.config.windowSecs);
        return errorRate(stats);
    }

    /**
     * Acquire: should we attempt a Redis call?
     * Returns a rejection outcome, or `null` to proceed.
     */
    acquire(): RedisCallOutcome | null {
        if (this.state === 'CLOSED') {
            if (this.inflight >= this.config.maxInflight) {
                this.circuitRejectedTotal += 1;
                return 'CONCURRENCY_REJECTED';
            }
            this.inflight += 1;
            return null;
        }

        if (this.state === 'OPEN') {
            if (Date.now() - this.openedAtMs >= this.cooldownMs) {
                // Attempt OPEN -> HALF_OPEN
                if (this.state === 'OPEN') {
                    this.state = 'HALF_OPEN';
                    this.probesDispatched = 0;
                    this.halfOpenSuccesses = 0;
                    this.halfOpenStartedAtMs = Date.now();
                    this.circuitHalfOpenTotal += 1;
                    otelLog('info', '[redis_cb] OPEN -> HALF_OPEN (cooldown elapsed)', { circuit: 'HALF_OPEN' });
                }
                return this.acquireHalfOpen();
            }
            this.circuitRejectedTotal += 1;
            return 'CIRCUIT_OPEN';
        }

        return this.acquireHalfOpen();
    }

    private acquireHalfOpen(): RedisCallOutcome | null {
        // §18/§19 — HALF_OPEN must never wedge. If the circuit has been probing
        // for `halfOpenMaxMs` without a confirmed recovery, re-arm OPEN with a
        // fresh jittered cooldown so the fleet retries deliberately later.
        // Current requests keep using the degradation path.
        if (Date.now() - this.halfOpenStartedAtMs >= this.config.halfOpenMaxMs) {
            if (this.state === 'HALF_OPEN') {
                this.tripOpen('HALF_OPEN recovery deadline reached');
            }
            this.circuitRejectedTotal += 1;
            return 'CIRCUIT_OPEN';
        }

        if (this.probesDispatched >= this.config.halfOpenProbes) {
            this.circuitRejectedTotal += 1;
            return 'CIRCUIT_OPEN';
        }
        if (this.inflight >= this.config.halfOpenProbes) {
            this.circuitRejectedTotal += 1;
            return 'CONCURRENCY_REJECTED';
        }
        this.probesDispatched += 1;
        this.inflight += 1;
        return null;
    }

    /** Must be called after every Redis operation (paired with acquire). */
    release(outcome: RedisCallOutcome, latencyUs: number): void {
        this.inflight = Math.max(0, this.inflight - 1);
        this.window.record(outcome, latencyUs);
        this.requestsTotal += 1;

        if (outcome === 'SUCCESS') {
            this.successTotal += 1;
            this.consecutiveFail = 0;
            this.consecutiveTimeout = 0;

            if (this.state === 'HALF_OPEN') {
                this.halfOpenSuccesses += 1;
                if (this.halfOpenSuccesses >= this.config.recoverySuccesses) {
                    const stats = this.window.aggregate(this.config.windowSecs);
                    const p99 = percentileUs(stats, 99);
                    if (p99 <= this.config.p99UsRecovery
                        && errorRate(stats) <= this.config.errorRateRecovery) {
                        this.state = 'CLOSED';
                        otelLog(
                            'info',
                            `[redis_cb] HALF_OPEN -> CLOSED (recovery confirmed, p99=${p99}us, err_rate=${errorRate(stats).toFixed(2)})`,
                            { circuit: 'CLOSED', p99Us: p99, errorRate: errorRate(stats) },
                        );
                    }
                }
            } else {
                this.checkStatisticalOpen();
            }
            return;
        }

        if (outcome === 'TIMEOUT') {
            // §8 — timeouts do NOT count toward errorsTotal or the rolling
            // error rate; they are a distinct health signal.
            this.timeoutsTotal += 1;
            this.consecutiveFail += 1;
            this.consecutiveTimeout += 1;

            if (this.state === 'HALF_OPEN') {
                this.tripOpen('HALF_OPEN probe timeout');
                return;
            }
            if (this.consecutiveTimeout >= this.config.consecutiveTimeoutOpen
                || this.consecutiveFail >= this.config.consecutiveFailOpen) {
                this.tripOpen(`consecutive failures=${this.consecutiveFail} timeouts=${this.consecutiveTimeout}`);
                return;
            }
            this.checkStatisticalOpen();
            return;
        }

        if (outcome === 'REDIS_ERROR') {
            this.errorsTotal += 1;
            this.consecutiveFail += 1;

            if (this.state === 'HALF_OPEN') {
                this.tripOpen('HALF_OPEN probe failed');
                return;
            }
            if (this.consecutiveFail >= this.config.consecutiveFailOpen) {
                this.tripOpen(`consecutive failures=${this.consecutiveFail}`);
                return;
            }
            this.checkStatisticalOpen();
            return;
        }

        // CIRCUIT_OPEN / CONCURRENCY_REJECTED are never passed to release().
    }

    /** Statistical detector — sustained degradation over the rolling window. */
    private checkStatisticalOpen(): void {
        const cfg = this.config;
        const stats = this.window.aggregate(cfg.windowSecs);

        // Minimum sample size before statistical decisions (§10).
        if (stats.total < cfg.minSamples) return;

        const errRate = errorRate(stats);
        const toRate = timeoutRate(stats);
        const p99 = percentileUs(stats, 99);

        if (errRate >= cfg.errorRateOpen
            || toRate >= cfg.timeoutRateOpen
            || p99 >= cfg.p99UsOpen) {
            this.tripOpen(
                `rolling stats: err_rate=${errRate.toFixed(2)} timeout_rate=${toRate.toFixed(2)} p99=${p99}us`,
            );
        }
    }

    private tripOpen(reason: string): void {
        const cfg = this.config;
        // Randomized jitter so fleet instances do not all probe Redis at the
        // same instant after recovery (§20, §21).
        const jitterMs = cfg.cooldownJitterMs > 0
            ? Math.floor(Math.random() * cfg.cooldownJitterMs)
            : 0;
        const effectiveCooldown = cfg.openCooldownMs + jitterMs;

        if (this.state !== 'OPEN') {
            this.state = 'OPEN';
            this.openedAtMs = Date.now();
            this.cooldownMs = effectiveCooldown;
            this.circuitOpenTotal += 1;
            otelLog('warn', `[redis_cb] -> OPEN: ${reason} (cooldown=${effectiveCooldown}ms)`, { circuit: 'OPEN', reason, cooldownMs: effectiveCooldown });
        }
    }

    /** Reset the breaker to CLOSED (test helper / admin reset). */
    reset(): void {
        this.state = 'CLOSED';
        this.consecutiveFail = 0;
        this.consecutiveTimeout = 0;
        this.probesDispatched = 0;
        this.halfOpenSuccesses = 0;
        this.halfOpenStartedAtMs = 0;
        this.inflight = 0;
        this.window.reset();
    }
}

export function classifyRedisError(err: unknown): RedisCallOutcome {
    const e = err as { name?: string; message?: string; code?: string } | undefined;
    const message = `${e?.message ?? String(err)}`;
    if (
        message.toLowerCase().includes('timed out')
        || message.toLowerCase().includes('wouldblock')
        || message.toLowerCase().includes('timeout')
        || e?.code === 'ETIMEDOUT'
    ) {
        return 'TIMEOUT';
    }
    return 'REDIS_ERROR';
}

/**
 * Execute an async Redis command under circuit-breaker protection.
 *
 * - If the circuit is OPEN or the concurrency limit is reached, returns
 *   immediately with `{ ok: false, outcome }` without invoking `fn`.
 * - Otherwise invokes `fn`, measures latency, records the outcome, and returns
 *   `{ ok: true, value }`.
 *
 * The caller decides the degradation policy from `outcome` (fail-open,
 * fail-closed, memory fallback).
 */
export async function withCircuitBreaker<T>(
    breaker: CircuitBreaker,
    fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; outcome: RedisCallOutcome }> {
    const rejected = breaker.acquire();
    if (rejected !== null) {
        return { ok: false, outcome: rejected };
    }

    return await new Promise((resolve) => {
        const start = process.hrtime.bigint();
        let settled = false;

        const finish = (outcome: RedisCallOutcome, value?: T): void => {
            if (settled) return; // settle-once — timer and fn race
            settled = true;
            const elapsedUs = Math.round(Number(process.hrtime.bigint() - start) / 1e3);
            breaker.release(outcome, elapsedUs);
            if (outcome === 'SUCCESS') {
                resolve({ ok: true, value: value as T });
            } else {
                resolve({ ok: false, outcome });
            }
        };

        // Breaker-level operation deadline (§14): ioredis `commandTimeout` does
        // NOT apply to commands queued while the connection is offline
        // (enableOfflineQueue + lazyConnect). The breaker timeout guarantees the
        // inflight slot is always released and the circuit observes the operation
        // as a TIMEOUT, even if `fn` would otherwise hang forever.
        const timer = setTimeout(() => finish('TIMEOUT'), breaker.config.operationTimeoutMs);
        // Do not keep the process alive solely for breaker timeout timers.
        timer.unref();

        fn().then(
            (value) => {
                clearTimeout(timer);
                finish('SUCCESS', value);
            },
            (err) => {
                clearTimeout(timer);
                finish(classifyRedisError(err));
            },
        );
    });
}

/**
 * Process-wide breaker for the UAM backend's Redis dependency. All Redis
 * commands (cache pool and rate-limit pool) route through this one breaker.
 */
export const redisCircuitBreaker = new CircuitBreaker(defaultCircuitBreakerConfig());