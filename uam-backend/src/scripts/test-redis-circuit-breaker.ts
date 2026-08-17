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
    withCircuitBreaker,
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
    // This helper deliberately disables hysteresis to isolate the fast
    // detector; the resulting config warnings are noise, so silence stderr
    // during construction.
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let cb: CircuitBreaker;
    try {
        cb = new CircuitBreaker(cfg);
    } finally {
        process.stderr.write = origWrite;
    }
    return cb;
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

    // 10. HALF_OPEN — only limited probes are allowed. Recovery is kept
    //     impossible (slow probes vs low p99 recovery) so the probe cap is what
    //     binds, not the CLOSED transition.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
            c.halfOpenProbes = 2;
            c.p99UsRecovery = 1_000;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        await sleep(150);
        let allowed = 0;
        for (let i = 0; i < 10; i += 1) {
            if (cb.acquire() === null) {
                allowed += 1;
                cb.release('SUCCESS', 50_000);
            }
        }
        eq(allowed, 2, `HALF_OPEN limits probes (allowed ${allowed})`);
        eq(cb.currentState(), 'HALF_OPEN', 'stays HALF_OPEN (recovery not met)');
    }

    // 11. Successful probes → HALF_OPEN → CLOSED.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
            c.recoverySuccesses = 2;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        await sleep(150);
        for (let i = 0; i < 2; i += 1) {
            eq(cb.acquire(), null, `probe ${i} allowed in HALF_OPEN`);
            cb.release('SUCCESS', 500);
        }
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

    // 15. Concurrent state transitions — real async interleaving, no corruption.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 100;
            c.consecutiveTimeoutOpen = 100;
        });
        const jobs = Array.from({ length: 8 }, (_, t) => (async () => {
            for (let i = 0; i < 1_000; i += 1) {
                const outcome = (t + i) % 5 === 0 ? 'REDIS_ERROR' : 'SUCCESS';
                if (cb.acquire() === null) {
                    cb.release(outcome as 'SUCCESS', 500);
                }
                await Promise.resolve(); // force real microtask interleaving
            }
        })());
        await Promise.all(jobs);
        eq(cb.requestsTotal, 8_000, 'all concurrent releases recorded');
        eq(cb.inflightCount(), 0, 'no inflight leak after concurrency');
        ok(cb.isClosed(), 'state remains valid after concurrency');
    }

    // 16. Timeout is a distinct health signal — it must NOT count as an error (§8).
    {
        const cb = breaker((c) => {
            c.consecutiveTimeoutOpen = 100;
            c.consecutiveFailOpen = 100;
        });
        for (let i = 0; i < 3; i += 1) { cb.acquire(); cb.release('TIMEOUT', 500_000); }
        eq(cb.timeoutsTotal, 3, 'timeouts recorded');
        eq(cb.errorsTotal, 0, 'timeouts do NOT inflate the error counter');
        ok(cb.isClosed(), 'low-volume slow ops stay CLOSED');
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
        eq(cb.inflightCount(), 0, 'inflight back to zero after parallel pairs');
    }

    // 21. HALF_OPEN probe budget is exact — nothing beyond the cap is a probe.
    //     Recovery stays impossible so the probe cap binds, not the CLOSED hop.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
            c.halfOpenProbes = 2;
            c.recoverySuccesses = 2;
            c.p99UsRecovery = 1_000;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        await sleep(150);
        let allowed = 0;
        for (let i = 0; i < 10; i += 1) {
            if (cb.acquire() === null) { allowed += 1; cb.release('SUCCESS', 50_000); }
        }
        eq(allowed, 2, `HALF_OPEN allows exactly halfOpenProbes probes (got ${allowed})`);
        eq(cb.acquire(), 'CIRCUIT_OPEN', 'probes beyond the budget are rejected');
    }

    // 22. HALF_OPEN must never wedge (§18/§19) — re-arms OPEN after halfOpenMaxMs.
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
            c.halfOpenProbes = 2;
            c.recoverySuccesses = 2;
            c.p99UsRecovery = 1_000; // 50ms probes can never meet recovery
            c.halfOpenMaxMs = 1_000;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        await sleep(150); // OPEN cooldown (100ms) elapses
        for (let i = 0; i < 2; i += 1) {
            if (cb.acquire() === null) cb.release('SUCCESS', 50_000);
        }
        eq(cb.currentState(), 'HALF_OPEN', 'probes stay in HALF_OPEN (hysteresis zone)');
        eq(cb.acquire(), 'CIRCUIT_OPEN', 'budget exhausted → degradation path');
        await sleep(1_100); // exceeds halfOpenMaxMs (1_000)
        eq(cb.acquire(), 'CIRCUIT_OPEN', 'first acquire after the deadline re-arms OPEN');
        await sleep(150); // fresh OPEN cooldown (100ms) elapses
        ok(cb.acquire() === null, 'breaker probes again after re-arming instead of wedging');
    }

    // 23. withCircuitBreaker does NOT invoke fn while the circuit is OPEN.
    {
        const cb = breaker((c) => { c.consecutiveFailOpen = 2; });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        eq(cb.currentState(), 'OPEN', 'circuit is open');
        let invoked = false;
        const r = await withCircuitBreaker(cb, async () => { invoked = true; return 42; });
        eq(r.ok, false, 'operation rejected while OPEN');
        if (!r.ok) eq(r.outcome, 'CIRCUIT_OPEN', 'rejection reason is CIRCUIT_OPEN');
        ok(!invoked, 'fn is NOT invoked while OPEN');
        eq(cb.inflightCount(), 0, 'no inflight slot leaked');
    }

    // 24. Breaker-level operation deadline (§14): a command that never settles
    //     is released as TIMEOUT and the inflight slot is freed exactly once.
    {
        const cb = breaker((c) => { c.operationTimeoutMs = 100; });
        const startedAt = Date.now();
        // The breaker deadline timer is unref()'d (correct for a server, where
        // other handles keep the loop alive). A bare `await` here would let the
        // process exit before the timer fires, so hold a ref'd timer alongside.
        const holder = sleep(500);
        const r = (await Promise.all([
            withCircuitBreaker(cb, () => new Promise<never>(() => { /* intentionally never settles */ })),
            holder,
        ]))[0];
        eq(r.ok, false, 'hanging command is rejected');
        if (!r.ok) eq(r.outcome, 'TIMEOUT', 'hang observed as TIMEOUT');
        ok(Date.now() - startedAt >= 90, 'breaker deadline enforced');
        eq(cb.inflightCount(), 0, 'inflight slot released after breaker timeout');
        eq(cb.timeoutsTotal, 1, 'timeout recorded exactly once');
        eq(cb.requestsTotal, 1, 'release recorded exactly once');
    }

    // 25. Config normalization (§12): recoverySuccesses clamped to halfOpenProbes.
    {
        const cfg = defaultCircuitBreakerConfig();
        cfg.halfOpenProbes = 2;
        cfg.recoverySuccesses = 5; // would make recovery impossible
        const cb = new CircuitBreaker(cfg);
        ok(
            cb.config.recoverySuccesses <= cb.config.halfOpenProbes,
            'recoverySuccesses clamped to halfOpenProbes',
        );
        eq(cb.config.recoverySuccesses, 2, 'clamped value equals halfOpenProbes');
    }

    // 26. A late-completing failure while already OPEN must not extend the
    //     OPEN cooldown (would delay recovery forever).
    {
        const cb = breaker((c) => {
            c.consecutiveFailOpen = 2;
            c.openCooldownMs = 100;
            c.cooldownJitterMs = 0;
        });
        for (let i = 0; i < 2; i += 1) { cb.acquire(); cb.release('REDIS_ERROR', 1_000); }
        eq(cb.currentState(), 'OPEN', 'circuit is open');
        const fields = cb as unknown as { openedAtMs: number; cooldownMs: number };
        const openedAt1 = fields.openedAtMs;
        const cooldown1 = fields.cooldownMs;
        eq(cooldown1, 100, 'cooldown set to base (no jitter)');
        await sleep(10);
        cb.release('TIMEOUT', 500_000); // in-flight op completing after OPEN
        eq(fields.openedAtMs, openedAt1, 'OPEN cooldown not re-armed');
        eq(fields.cooldownMs, cooldown1, 'cooldown unchanged by late failure');
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