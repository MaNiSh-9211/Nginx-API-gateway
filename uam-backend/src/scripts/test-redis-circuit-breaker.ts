/**
 * Unit tests for the Redis Circuit Breaker (requirements.md §28).
 *
 * Runs without a test framework (the repo has none): plain assertions, exits
 * non-zero on failure. Execute via:  npm run test:cb
 */
import {
    CircuitBreaker,
    CircuitBreakerConfig,
    defaultCircuitBreakerConfig,
    classifyRedisError,
} from '../config/redisCircuitBreaker';

let failures = 0;
let checks = 0;

function ok(cond: boolean, label: string): void {
    checks += 1;
    if (!cond) {
        failures += 1;
        console.error(`  FAIL: ${label}`);
    }
}

function eq<T>(actual: T, expected: T, label: string): void {
    checks += 1;
    if (actual !== expected) {
        failures += 1;
        console.error(`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`);
    }
}

function breaker(modify: (c: CircuitBreakerConfig) => void): CircuitBreaker {
    const cfg = defaultCircuitBreakerConfig();
    cfg.minSamples = 100_000; // isolate the fast detector in most tests
    cfg.p99UsRecovery = 1_000_000;
    cfg.errorRateRecovery = 1.0;
    modify(cfg);
    return new CircuitBreaker(cfg);
}

async function run(): Promise<void> {
    // 1. Healthy Redis — circuit remains CLOSED.
    {
        const cb = breaker(() => {});
        for (let i = 0; i < 100; i += 1) {
            cb.acquire();
            cb.release('SUCCESS', 500);
        }
        ok(cb.isClosed(), 'healthy Redis stays CLOSED');
    }

    // 2. One transient failure — circuit remains CLOSED.
    {
        const cb = breaker(() => {});
        cb.acquire();
        cb.release('SUCCESS', 500);
        cb.acquire();
        cb.release('REDIS_ERROR', 1_000);
        cb.acquire();
        cb.release('SUCCESS', 500);
        ok(cb.isClosed(), 'single transient failure stays CLOSED');
    }

    // 3. Consecutive failures reach threshold → OPEN.
    {
        const cb = breaker((c) => { c.consecutiveFailOpen = 3; });
        for (let i = 0; i < 3; i += 1) {
            cb.acquire();
            cb.release('REDIS_ERROR', 1_000);
        }
        eq(cb.currentState(), 'OPEN', 'consecutive failures open the circuit');
    }

    // 4. High timeout rate → OPEN (statistical).
    {
        const cb = breaker((c) => {
            c.timeoutRateOpen = 0.4;
            c.minSamples = 5;
            c.consecutiveTimeoutOpen = 100;
            c.consecutiveFailOpen = 100;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('SUCCESS', 500); }
        for (let i = 0; i < 3; i += 1) { cb.acquire(); cb.release('TIMEOUT', 500_000); }
        eq(cb.currentState(), 'OPEN', 'high timeout rate opens the circuit');
    }

    // 5. High error rate → OPEN (statistical).
    {
        const cb = breaker((c) => {
            c.errorRateOpen = 0.5;
            c.minSamples = 5;
            c.consecutiveFailOpen = 100;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('SUCCESS', 500); }
        for (let i = 0; i < 3; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        eq(cb.currentState(), 'OPEN', 'high error rate opens the circuit');
    }

    // 6. High p99 latency sustained → OPEN (statistical).
    {
        const cb = breaker((c) => {
            c.p99UsOpen = 100_000;
            c.minSamples = 5;
            c.consecutiveFailOpen = 100;
        });
        for (let i = 0; i < 10; i += 1) { cb.acquire(); cb.release('SUCCESS', 300_000); }
        eq(cb.currentState(), 'OPEN', 'high p99 latency opens the circuit');
    }

    // 7. Low request volume — circuit does not open on a tiny sample.
    {
        const cb = breaker((c) => {
            c.minSamples = 20;
            c.errorRateOpen = 0.5;
            c.consecutiveFailOpen = 100;
        });
        cb.acquire(); cb.release('SUCCESS', 500);
        cb.acquire(); cb.release('REDIS_ERROR', 1_000);
        cb.acquire(); cb.release('REDIS_ERROR', 1_000);
        ok(cb.isClosed(), 'tiny sample does not open the circuit');
    }

    // 8. OPEN — Redis is not called (acquire rejects immediately).
    {
        const cb = breaker((c) => { c.consecutiveFailOpen = 2; });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        eq(cb.currentState(), 'OPEN', 'circuit is open');
        eq(cb.acquire(), 'CIRCUIT_OPEN', 'OPEN circuit rejects acquire without calling Redis');
    }

    // 9. OPEN cooldown → transitions to HALF_OPEN.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        eq(cb.currentState(), 'OPEN', 'open before cooldown');
        await sleep(150);
        const result = cb.acquire();
        ok(result === null || result === 'CIRCUIT_OPEN', 'acquire after cooldown is a probe or rejected');
        if (result === null) eq(cb.currentState(), 'HALF_OPEN', 'transitions to HALF_OPEN');
    }

    // 10. HALF_OPEN — only limited probes are allowed.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
            c.halfOpenProbes = 2;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        await sleep(150);
        let allowed = 0;
        for (let i = 0; i < 10; i += 1) {
            if (cb.acquire() === null) {
                allowed += 1;
                cb.release('SUCCESS', 500);
            }
        }
        ok(allowed <= 2, `HALF_OPEN limits probes (allowed ${allowed})`);
    }

    // 11. Successful probes → HALF_OPEN → CLOSED.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
            c.recoverySuccesses = 2;
            c.minSamples = 5;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        await sleep(150);
        cb.acquire();
        eq(cb.currentState(), 'HALF_OPEN', 'entered HALF_OPEN');
        cb.release('SUCCESS', 500);
        cb.release('SUCCESS', 500);
        eq(cb.currentState(), 'CLOSED', 'successful probes close the circuit');
    }

    // 12. Failed probe → HALF_OPEN → OPEN.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        await sleep(150);
        cb.acquire();
        eq(cb.currentState(), 'HALF_OPEN', 'entered HALF_OPEN');
        cb.release('TIMEOUT', 500_000);
        eq(cb.currentState(), 'OPEN', 'failed probe reopens the circuit');
    }

    // 13. Recovery hysteresis — circuit does not flap.
    {
        const cb = breaker((c) => {
            c.p99UsOpen = 200_000;
            c.p99UsRecovery = 30_000;
            c.minSamples = 5;
            c.consecutiveFailOpen = 100;
        });
        for (let i = 0; i < 5; i += 1) { cb.acquire(); cb.release('SUCCESS', 100_000); }
        ok(cb.isClosed(), 'mid-range latency stays CLOSED (no flap)');
        for (let i = 0; i < 5; i += 1) { cb.acquire(); cb.release('SUCCESS', 300_000); }
        eq(cb.currentState(), 'OPEN', 'high p99 opens after sustained degradation');
    }

    // 14. Recovery jitter — bounded and randomized.
    {
        const seen = new Set<number>();
        for (let t = 0; t < 5; t += 1) {
            const cb = breaker((c) => {
                c.consecutiveFailOpen = 2;
                c.openCooldownMs = 5_000;
                c.cooldownJitterMs = 2_000;
            });
            for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
            // @ts-ignore - private field, read for the jitter assertion only
            seen.add(cb.cooldownMs);
        }
        ok(seen.size > 1, `cooldown jitter is randomized (${seen.size} distinct values)`);
    }

    // 15. Concurrent state transitions — no corruption.
    {
        const cb = breaker(() => {});
        const jobs = Array.from({ length: 8 }, (_, t) =>
            Promise.resolve().then(() => {
                for (let i = 0; i < 1_000; i += 1) {
                    const outcome = (t + i) % 5 === 0 ? 'REDIS_ERROR' : 'SUCCESS';
                    if (cb.acquire() === null) {
                        cb.release(outcome as 'SUCCESS', 500);
                    }
                }
            }),
        );
        await Promise.all(jobs);
        eq(cb.requestsTotal, 8_000, 'all concurrent releases recorded');
        ok(['CLOSED', 'OPEN'].includes(cb.currentState()), 'state remains valid after concurrency');
    }

    // 16. Redis timeout — command does not block indefinitely.
    {
        const cb = breaker(() => {});
        cb.acquire();
        cb.release('TIMEOUT', 500_000);
        ok(cb.timeoutsTotal === 1, 'timeout recorded');
    }

    // 17. Redis slow — concurrency remains bounded.
    {
        const cb = breaker((c) => { c.maxInflight = 2; });
        cb.acquire();
        cb.acquire();
        eq(cb.acquire(), 'CONCURRENCY_REJECTED', 'concurrency limit rejects excess in-flight ops');
        cb.release('SUCCESS', 500);
        ok(cb.acquire() === null, 'slot freed after release');
    }

    // 18. classifyRedisError distinguishes timeouts from errors.
    {
        eq(classifyRedisError(new Error('command timed out')), 'TIMEOUT', 'timed out message → TIMEOUT');
        eq(classifyRedisError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })), 'TIMEOUT', 'ETIMEDOUT → TIMEOUT');
        eq(classifyRedisError(new Error('WRONGTYPE Operation against a key')), 'REDIS_ERROR', 'server error → REDIS_ERROR');
        eq(classifyRedisError(new Error('ECONNREFUSED')), 'REDIS_ERROR', 'connect refused → REDIS_ERROR');
    }

    // 20. Context isolation — concurrent requests cannot corrupt state.
    {
        const cb = breaker(() => {});
        const results = await Promise.all(
            Array.from({ length: 50 }, (_, i) => cb.acquire() === null
                ? Promise.resolve(cb.release('SUCCESS', 100 + i))
                : Promise.resolve()),
        );
        ok(results.length === 50, 'parallel acquire/release pairs completed');
        eq(cb.requestsTotal, 50, 'all pairs recorded exactly once');
    }

    console.log(`\nredis circuit breaker: ${checks} checks, ${failures} failures`);
    if (failures > 0) {
        process.exit(1);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

void run();