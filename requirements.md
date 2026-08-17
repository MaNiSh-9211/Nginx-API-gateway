I want you to implement production-grade Redis dependency health monitoring and a local circuit breaker for this codebase.

IMPORTANT:
We currently DO NOT have circuit breaking implemented.

Do not blindly modify the code.

First inspect the repository and understand exactly how Redis is currently used, especially:

- Redis client/library
- connection pool
- Redis commands
- rate limiting
- revocation checks
- Bloom filter logic
- mmap-backed data
- async/concurrent execution
- timeout configuration
- retry behavior
- logging
- metrics
- application startup/shutdown
- existing health checks
- existing middleware/interceptors
- existing error handling

Search the entire repository for:

- Redis
- redis
- timeout
- retry
- reconnect
- connection pool
- rate limit
- revocation
- circuit
- breaker
- health
- latency
- metrics
- Prometheus
- OpenTelemetry

Do not create duplicate functionality if something already exists.

==================================================
GOAL
==================================================

Introduce a LOCAL Redis circuit breaker and dependency-health evaluator.

The circuit breaker must protect the gateway/application from Redis becoming:

- slow
- unavailable
- timing out
- returning errors
- overloaded

The implementation must prevent Redis from becoming a cascading-failure source.

The circuit breaker must be local to each application/gateway instance.

DO NOT create a distributed/global circuit breaker using Redis.

DO NOT store circuit-breaker state in Redis.

DO NOT require network coordination between gateway nodes.

Example:

Gateway A → local Redis circuit breaker
Gateway B → local Redis circuit breaker
Gateway C → local Redis circuit breaker

Each instance independently determines whether it should call Redis.

==================================================
1. FIRST: ARCHITECTURAL ANALYSIS
==================================================

Before implementation, identify:

1. Where Redis calls originate.
2. Which Redis operations are on the request hot path.
3. Which Redis operations are background/control-plane operations.
4. Which operations are latency-sensitive.
5. Which operations are security-sensitive.
6. Which Redis calls are idempotent.
7. Which calls currently retry.
8. Which calls currently have timeouts.
9. Whether there is a Redis connection pool.
10. Whether multiple Redis operations can execute concurrently.
11. Whether Redis is used for rate limiting.
12. Whether Redis is used for revocation.
13. Whether Redis is used for anything else.

Then explain the current Redis failure behavior.

Do not implement anything until you understand the existing failure paths.

==================================================
2. IMPORTANT DESIGN PRINCIPLE
==================================================

Separate these concepts:

METRICS:
What is Redis doing?

HEALTH EVALUATOR:
Does the recent evidence indicate Redis is unhealthy?

CIRCUIT BREAKER:
Should this application currently send Redis requests?

DEGRADATION POLICY:
What should the application do when Redis is unavailable?

Do NOT combine all of these into one giant function.

The architecture should conceptually be:

Redis operation
      |
      v
Operation timeout / concurrency protection
      |
      v
Redis result
      |
      v
Health recorder
      |
      +--> latency
      +--> errors
      +--> timeouts
      +--> consecutive failures
      |
      v
Health evaluator
      |
      v
Circuit breaker
      |
      +--> CLOSED
      +--> OPEN
      +--> HALF_OPEN
      |
      v
Degradation policy

==================================================
3. CIRCUIT BREAKER STATES
==================================================

Implement:

CLOSED
OPEN
HALF_OPEN

CLOSED:

Normal operation.

Redis requests are allowed.

Health metrics are continuously recorded.

OPEN:

Redis is considered unhealthy.

Normal Redis requests must NOT be sent.

The caller must immediately receive a circuit-open result and follow the appropriate existing degradation behavior.

Do not wait for Redis timeout while the circuit is OPEN.

HALF_OPEN:

After the configured cooldown period, allow a very small number of probe requests.

Do NOT allow the entire traffic flow to suddenly hit Redis.

If probes succeed consistently:

HALF_OPEN → CLOSED

If probes fail:

HALF_OPEN → OPEN

==================================================
4. LOCAL STATE ONLY
==================================================

Circuit state must be process-local.

Do not use:

- Redis
- database
- distributed lock
- consensus
- shared network state

for circuit state.

A gateway instance must be able to operate its circuit breaker independently.

Use thread-safe / concurrency-safe primitives appropriate for the language.

Avoid global mutable state that can leak across requests.

==================================================
5. HEALTH SIGNALS
==================================================

Implement these signals:

1. Rolling latency
2. Error rate
3. Timeout rate
4. Consecutive failures

Do NOT treat all signals as identical.

Use them as evidence for the health evaluator.

==================================================
6. ROLLING LATENCY
==================================================

Do NOT store every Redis latency measurement.

Use an efficient local rolling-window structure.

Prefer time buckets.

Example:

10-second rolling window:

second 1
second 2
second 3
...
second 10

Each bucket should maintain enough information to estimate latency distribution.

Prefer a histogram/sketch appropriate for the existing language/framework.

At minimum support:

- p50
- p95
- p99

Circuit-breaking decisions should primarily consider tail latency such as p99 rather than average latency.

The implementation must be memory bounded.

Do not create an unbounded list/vector of latency samples.

==================================================
7. ERROR RATE
==================================================

Track:

errors / total requests

Define errors explicitly.

Include failures such as:

- Redis connection failure
- connection reset
- Redis server error
- protocol error
- command failure

Do not classify every application-level result as a Redis infrastructure error.

For example, distinguish:

Redis infrastructure failure

from:

Redis successfully responded that a key does not exist.

==================================================
8. TIMEOUT RATE
==================================================

Track timeout rate separately from general errors.

A timeout means:

The application waited until its configured Redis operation deadline and did not receive a usable result.

Timeouts are a particularly important health signal because Redis can be unhealthy without returning explicit errors.

Do not allow Redis timeouts to block request threads/tasks indefinitely.

==================================================
9. CONSECUTIVE FAILURES
==================================================

Maintain a fast failure detector.

Example conceptual behavior:

success
success
failure
failure
failure
failure
failure

If the configured consecutive failure threshold is reached:

→ strong signal to OPEN the circuit.

But do not rely only on consecutive failures.

Transient failures must not cause excessive flapping.

Use atomic/thread-safe state updates.

==================================================
10. MINIMUM SAMPLE SIZE
==================================================

Do NOT make circuit decisions based on tiny samples.

For example:

3 Redis requests
2 failures
= 66% error rate

should not automatically mean Redis is unhealthy.

Require a configurable minimum number of observations before using rolling error/timeout/latency thresholds.

Make this configurable.

==================================================
11. FAST DETECTOR + STATISTICAL DETECTOR
==================================================

Use two complementary detection mechanisms.

FAST DETECTOR:

Used for obvious failures.

Examples:

- consecutive failures >= threshold
- consecutive timeouts >= threshold

STATISTICAL DETECTOR:

Used for sustained degradation.

Examples:

- timeout rate above threshold
- error rate above threshold
- p99 latency above threshold

The final OPEN decision should be based on clearly documented rules.

Do NOT create an unnecessarily complicated mathematical scoring system.

Keep the rules deterministic and explainable.

==================================================
12. HYSTERESIS
==================================================

The circuit must use different OPEN and RECOVERY thresholds.

Do NOT use the same threshold in both directions.

Example concept:

OPEN:

p99 > 100ms

RECOVERY:

p99 < 30ms

This prevents:

50ms → open
49ms → closed
51ms → open
49ms → closed

from causing rapid state flapping.

Make thresholds configurable.

Do not blindly use these example numbers in production.

Choose defaults based on the existing system's actual Redis latency profile if possible.

==================================================
13. BASELINE-AWARE LATENCY
==================================================

Evaluate whether the existing system has a stable Redis latency baseline.

If practical, support both:

ABSOLUTE THRESHOLD:

p99 > configured maximum

RELATIVE DEGRADATION:

current p99 significantly exceeds the established baseline

Do not implement an overly complex adaptive algorithm.

Do not allow the baseline to continuously follow an unhealthy Redis state.

If baseline-aware detection is implemented, bound it and document it.

If it adds unnecessary complexity for the current codebase, implement absolute thresholds first and document relative-baseline support as a future improvement.

==================================================
14. OPERATION TIMEOUT
==================================================

Every Redis operation protected by the circuit breaker must have a bounded application-level timeout.

Do not rely only on:

- TCP timeout
- OS timeout
- connection timeout
- Redis client default timeout

The timeout must represent:

"How long is this application willing to wait for Redis for this particular operation?"

Make the timeout configurable.

Different Redis operations may require different timeout budgets.

Do not automatically apply an arbitrary 50ms timeout.

First inspect existing latency requirements.

==================================================
15. CONCURRENCY LIMIT
==================================================

Evaluate adding a local concurrency limit for Redis operations.

This protects the application when Redis becomes slow.

Example:

Maximum Redis operations in flight:

N

If N requests are already waiting on Redis:

do not allow unlimited additional Redis work to accumulate.

The implementation should prevent:

Redis slowdown
→ requests wait
→ concurrency increases
→ more Redis requests
→ Redis becomes slower
→ more requests wait

This is a feedback loop we explicitly want to prevent.

Use bounded concurrency.

Make it configurable.

==================================================
16. RETRIES
==================================================

Inspect the current retry behavior.

Do NOT blindly retry every Redis failure.

Retries can amplify an outage.

If retries already exist:

- document them
- ensure they are bounded
- ensure they have backoff/jitter where appropriate
- ensure they interact correctly with the circuit breaker

The circuit breaker should prevent retries from continuing indefinitely when Redis is unhealthy.

Do not introduce a retry storm.

==================================================
17. CIRCUIT OPEN BEHAVIOR
==================================================

When OPEN:

Redis should not be called for normal traffic.

The failure should be detected locally and quickly.

The caller must receive a structured internal result such as:

CIRCUIT_OPEN

rather than pretending that Redis itself returned an error.

The existing business/degradation layer should decide whether to:

- use local rate limiting
- use Bloom filter
- fail open
- fail closed
- use cached state
- reject the request

Do not embed business-specific degradation behavior inside the generic circuit breaker.

The circuit breaker only answers:

"Should I attempt Redis?"

==================================================
18. HALF-OPEN DESIGN
==================================================

Half-open must be protected against a recovery storm.

Do not let all requests pass through when the circuit transitions to HALF_OPEN.

Use a limited number of probes.

Possible design:

HALF_OPEN
    |
    +--> one/few probe requests
    |
    +--> all other requests continue using degradation behavior

Make the number of allowed probes configurable.

Use jitter around recovery timing.

==================================================
19. RECOVERY
==================================================

Do not immediately close the circuit after one successful request.

Require sustained evidence of recovery.

Possible recovery signals:

- N successful probes
- low timeout rate
- low error rate
- acceptable p99 latency
- minimum healthy period

Use a configurable recovery policy.

OPEN → HALF_OPEN → CLOSED

must be deliberate.

==================================================
20. RECOVERY JITTER
==================================================

Do not make every gateway use exactly the same recovery timer.

Bad:

all gateways:

5 seconds
→ HALF_OPEN
→ Redis

At fleet scale this can create a recovery storm.

Use randomized jitter.

For example conceptually:

base recovery delay
+
randomized jitter

Do not hard-code the example.

==================================================
21. FLEET BEHAVIOR
==================================================

The circuit breaker is local.

However, consider the fleet-level consequence.

Example:

100,000 gateway instances

Redis becomes unhealthy.

Do not create a design where all gateways:

- aggressively retry
- aggressively probe
- aggressively reconnect
- aggressively recover

at exactly the same time.

Use:

- bounded retries
- exponential backoff
- jitter
- bounded probes
- local circuit breakers

==================================================
22. METRICS
==================================================

Expose observability metrics for the circuit breaker itself.

At minimum:

redis_requests_total
redis_success_total
redis_errors_total
redis_timeouts_total
redis_latency
redis_circuit_state
redis_circuit_open_total
redis_circuit_half_open_total
redis_circuit_rejected_total

If the existing metrics system is Prometheus/OpenTelemetry/etc., use it.

Do not introduce another metrics framework unnecessarily.

Avoid high-cardinality labels.

DO NOT use:

user_id
request_id
trace_id
correlation_id

as metric labels.

Those belong in logs/traces, not metric labels.

==================================================
23. LOGGING
==================================================

Log state transitions:

CLOSED → OPEN
OPEN → HALF_OPEN
HALF_OPEN → CLOSED
HALF_OPEN → OPEN

Do not log every failed Redis request at ERROR level.

At high traffic this can cause a logging storm.

Use appropriate levels and rate limiting.

Include useful context such as:

- service
- circuit name
- previous state
- new state
- reason
- observed error rate
- timeout rate
- latency percentile
- consecutive failures

Do not log secrets or sensitive Redis data.

==================================================
24. TRACE INTEGRATION
==================================================

If distributed tracing exists:

Redis operations should appear as spans where appropriate.

The circuit breaker itself should not create excessive spans.

When the circuit is OPEN and Redis is not actually called:

do not create a fake Redis network span.

Instead, record the circuit-open event appropriately in application telemetry.

==================================================
25. FAILURE SEMANTICS
==================================================

Define explicit categories:

SUCCESS
REDIS_ERROR
TIMEOUT
CIRCUIT_OPEN
CONCURRENCY_REJECTED

Do not collapse everything into one generic error.

This will make the degradation logic much easier to reason about.

==================================================
26. CONFIGURATION
==================================================

Make thresholds configurable.

At minimum consider:

- rolling window duration
- bucket count
- minimum samples
- error-rate threshold
- timeout-rate threshold
- latency threshold
- consecutive failure threshold
- consecutive timeout threshold
- open cooldown
- half-open probe count
- recovery success threshold
- recovery latency threshold
- recovery error threshold
- Redis operation timeout
- Redis concurrency limit
- retry count
- retry backoff
- jitter

Provide safe defaults.

Do not create dozens of unnecessary configuration options if the existing application configuration style favors fewer settings.

Document every setting.

==================================================
27. IMPORTANT: DO NOT USE A CENTRALIZED HEALTH STATE
==================================================

Do not build:

Gateway
  ↓
Redis health service
  ↓
"Redis is unhealthy"

for the request path.

The health decision must be local.

Otherwise the health service itself becomes another dependency.

==================================================
28. TESTING
==================================================

Add comprehensive unit and integration tests.

At minimum test:

1. Healthy Redis:
   circuit remains CLOSED.

2. One transient failure:
   circuit remains CLOSED.

3. Consecutive failures reach threshold:
   circuit becomes OPEN.

4. High timeout rate:
   circuit opens.

5. High error rate:
   circuit opens.

6. High p99 latency sustained:
   circuit opens.

7. Low request volume:
   circuit does not open solely because of a tiny sample.

8. OPEN state:
   Redis is not called.

9. OPEN cooldown:
   transitions to HALF_OPEN.

10. HALF_OPEN:
   only limited probes are allowed.

11. Successful probes:
   HALF_OPEN → CLOSED.

12. Failed probe:
   HALF_OPEN → OPEN.

13. Recovery hysteresis:
   circuit does not flap.

14. Recovery jitter:
   behavior is randomized appropriately.

15. Concurrent state transitions:
   no race conditions.

16. Redis timeout:
   request does not block indefinitely.

17. Redis slow:
   concurrency remains bounded.

18. Retry behavior:
   retries remain bounded.

19. Circuit OPEN:
   existing degradation behavior is invoked.

20. Context isolation:
   concurrent requests cannot corrupt health/circuit state.

==================================================
29. LOAD TESTING
==================================================

If the repository already has a load-testing framework, use it.

Evaluate:

- circuit-breaker overhead
- lock contention
- atomic contention
- rolling-window overhead
- histogram overhead
- memory usage
- Redis concurrency limits
- behavior under Redis latency
- behavior under Redis complete outage
- recovery behavior

The circuit breaker must be extremely cheap in the CLOSED state.

A request should not pay significant overhead merely because the circuit breaker exists.

==================================================
30. IMPORTANT SCALE REQUIREMENT
==================================================

Assume this system may eventually operate at extremely high request rates.

Do NOT:

- allocate memory per request unnecessarily
- create unbounded queues
- store every latency sample
- use a centralized counter for circuit state
- make network calls to determine circuit state
- perform expensive locking on every request
- emit a log for every Redis failure
- create high-cardinality metrics

Prefer:

- bounded memory
- atomic operations
- lock-free/read-optimized approaches where appropriate
- time buckets
- bounded histograms
- local state
- cheap CLOSED-path checks

However, do not prematurely optimize with unsafe lock-free code if the existing language/framework has a safe efficient primitive.

Correctness comes first.

==================================================
31. IMPLEMENTATION PROCESS
==================================================

Follow this exact sequence:

PHASE 1:
Inspect repository.

PHASE 2:
Map all Redis call paths.

PHASE 3:
Identify existing timeout/retry/pool/metrics mechanisms.

PHASE 4:
Explain current Redis failure behavior.

PHASE 5:
Design the circuit breaker and health evaluator.

PHASE 6:
Show me the proposed architecture and state machine before making large changes.

PHASE 7:
Implement the smallest production-grade version.

PHASE 8:
Integrate it centrally rather than modifying every business operation individually.

PHASE 9:
Add tests.

PHASE 10:
Run the test suite.

PHASE 11:
Run lint/static analysis/build.

PHASE 12:
Perform a concurrency review.

PHASE 13:
Perform a failure-mode review.

==================================================
32. FINAL ARCHITECTURE SHOULD LOOK CONCEPTUALLY LIKE
==================================================

                         Redis
                           ^
                           |
                    bounded concurrency
                           |
                    operation timeout
                           |
                    Redis client call
                           |
                           v
                    Health Recorder
                           |
          ┌────────────────┼────────────────┐
          ↓                ↓                ↓
       latency           errors          timeouts
       histogram         counter          counter
          |                |                |
          └────────────────┼────────────────┘
                           ↓
                    Health Evaluator
                           |
                 ┌─────────┴─────────┐
                 ↓                   ↓
           Fast detector       Rolling detector
                 |                   |
                 └─────────┬─────────┘
                           ↓
                    Circuit Breaker
                           |
            ┌──────────────┼──────────────┐
            ↓              ↓              ↓
         CLOSED           OPEN         HALF_OPEN
            |              |              |
            ↓              ↓              ↓
        Redis call     no Redis       limited probes
                                           |
                                  ┌────────┴────────┐
                                  ↓                 ↓
                               success           failure
                                  ↓                 ↓
                               CLOSED             OPEN

# ==================================================
# LGTM STACK (OBSERVABILITY) — IMPLEMENTED (Grafana Cloud OTLP)
# ==================================================

Status: DONE — all three gateway/uam services emit OTLP (traces/metrics/logs)
directly to Grafana Cloud (Tempo/Mimir/Loki) at
`https://otlp-gateway-prod-ap-south-1.grafana.net/otlp` and the connection was
verified live (see per-service notes below). Creds live only in gitignored
`.env` files; `.env.example` holds blank placeholders.

Per-service implementation:

- **gateway-edge (OpenResty + Rust FFI):** hand-rolled OTLP/JSON exporter over
  `ureq` (rustls — no system libs) on a background thread spawned from
  `init_extension` (`rust-ext/src/otlp.rs`). Metrics: redis circuit-breaker
  state/inflight/p50/p95/p99/error-rate gauges, redis counters as deltas, HTTP
  request counters + latency from the shared-memory telemetry (cross-worker),
  uptime. redis_cb series carry a `gateway.worker_pid` label (per-worker state).
  Logs: startup + circuit-transition events. Traces: per-request spans pushed
  from `report_telemetry` via a bounded `try_send` channel (O(1), never on the
  access hot path). Env-gated on `OTEL_EXPORTER_OTLP_ENDPOINT`; `env` directives
  added to nginx.conf. Live-verified: metrics, logs, and traces all accepted
  (no 4xx/5xx) via the opt-in `live_otlp_export` test.
- **gateway-control-plane (Rust/Actix):** official OpenTelemetry SDK
  (`src/otlp.rs`) — trace batch exporter, 15 s periodic metric reader, log batch
  exporter, `OtelMetrics` actix Transform middleware (per-request `http.request`
  span + count/duration metrics), 10 s metric recorder. Live-verified: TLS
  connection to the Grafana Cloud host established; no export errors.
- **uam-backend (Node/Express):** `src/otel.ts` NodeSDK (traces/metrics/logs),
  env-gated, `otelLog` at all three circuit-transition points, OTel metrics for
  Redis + HTTP. Live-verified: server boot + /ready//health traffic + clean
  exporter flush on shutdown.

Remaining (not instrumented — out of current scope): gateway-sidecar,
demo-backend, demo-frontend, uam-frontend.

## What

Integrate the LGTM observability stack (Loki + Grafana + Tempo + Mimir) as the
production telemetry backend across all services in this monorepo:

- gateway-edge (OpenResty + Rust FFI)
- gateway-control-plane (Rust/Actix)
- gateway-sidecar (Rust)
- uam-backend (Node/Express)
- demo-backend, demo-frontend, uam-frontend

## Goals

1. **Logs → Loki:** centralized, searchable log aggregation with
   `{service=..., level=...}` labels. Ship via a Promtail / Grafana Agent /
   OpenTelemetry collector sidecar, or native HTTP push.
2. **Metrics → Mimir:** long-term storage for Prometheus metrics. The existing
   `/metrics` endpoints (gateway `redis_*`, control-plane `redis_*`, uam
   `uam_redis_*`, plus service-level metrics) must be remote-written to Mimir.
3. **Traces → Tempo:** distributed tracing across edge → control-plane →
   uam-backend (and upstreams). Requires instrumenting each service with an
   OpenTelemetry SDK/tracer:
   - gateway-edge: record Redis circuit-breaker + auth checks as spans
   - control-plane: trace admin config mutations, revoke, telemetry ingest
   - uam-backend: trace HTTP middleware (incoming requests) and outbound calls
     (control-plane `/revoke`, GitHub API)
   - The circuit breaker must NOT create fake network spans when OPEN
     (requirements.md §24) — record a circuit-open event instead.
4. **Dashboards → Grafana:** per-service dashboards for LGTM (logs/metrics/
   traces) plus the existing Redis dependency-health series.

## Config

- Credentials (endpoints, tenant IDs, API keys / basic auth) will be supplied
  by the user later. Nothing hardcoded — values go in each service's `.env`
  (gitignored) and `.env.example` placeholders.
- Preferred transport: OpenTelemetry Collector (OTLP) for logs+traces, Prometheus
  remote-write for metrics. Use the collector if practical, else Promtail/Agent.

## Constraints

- Gateway data plane stays fast: circuit-breaker hot path unchanged, no per-
  request allocation spikes, batching for traces/logs.
- No new high-cardinality metric labels (user_id, trace_id, etc. — §22).
- Gateway services must never connect to Postgres (store stays control-plane-only).

## Acceptance

- All services emit structured logs with service/level/trace_id correlation.
- All services' Prometheus metrics remote-write to Mimir and are queryable.
- A request path (edge → control-plane → uam-backend) is traceable in Tempo.
- Grafana dashboards render logs, metrics, traces, and circuit-breaker state.

==================================================
33. FINAL REPORT
==================================================

After implementation, provide:

1. Files changed.
2. Redis call paths discovered.
3. Circuit-breaker architecture.
4. State-machine explanation.
5. Health metrics used.
6. Exact OPEN conditions.
7. Exact HALF_OPEN conditions.
8. Exact CLOSED/recovery conditions.
9. Hysteresis behavior.
10. Timeout behavior.
11. Retry behavior.
12. Concurrency-limit behavior.
13. Metrics added.
14. Logs added.
15. Tests added.
16. Load tests performed.
17. Performance overhead measured if possible.
18. Known limitations.
19. Future improvements.

Most importantly:

DO NOT claim the implementation is production-ready merely because tests pass.

Explicitly identify any remaining assumptions, failure modes, or scale limitations.

==================================================
FINAL REPORT (IMPLEMENTATION COMPLETE — Redis Circuit Breaker)
==================================================

1. Files changed.

   - `gateway-edge/rust-ext/src/redis_cb.rs` — full breaker + health evaluator.
   - `gateway-edge/rust-ext/src/telemetry.rs` — `redis_*` Prometheus series
     (incl. p50/p95/p99 latency).
   - `gateway-edge/rust-ext/src/auth.rs` — token-version + revocation Redis
     calls wrapped in `with_circuit_breaker`; bounded retry (2 attempts,
     backoff + jitter, no retry on timeout); operation timeouts
     (`REDIS_AUTH_TIMEOUT_MS`).
   - `gateway-edge/rust-ext/src/rate_limit.rs` — fleet RL Redis sync wrapped
     in the breaker; fail-open degradation on Redis failure; operation
     timeout (`RATE_LIMIT_REDIS_TIMEOUT_MS`).
   - `gateway-control-plane/src/redis_cb.rs` — breaker (CP-prefixed env vars),
     `prometheus_metrics()`, single-shot Redis with bounded
     `CP_REDIS_TIMEOUT_MS`.
   - `gateway-control-plane/src/main.rs` — admin nonce falls back to in-memory
     on CIRCUIT_OPEN; `write_revocation_keys` → 503 on Redis failure; `/health`
     surfaces `redis_circuit`; `/metrics` embeds breaker metrics.
   - `uam-backend/src/config/redisCircuitBreaker.ts` — breaker + health
     evaluator (ioredis-compatible).
   - `uam-backend/src/config/redis.ts` — cache/rate-limit pools route through
     the breaker.
   - `uam-backend/src/metrics.ts` — `uam_redis_*` series; `*_total` are true
     Counters (delta increments), state/latency/error-rate are Gauges.
   - `uam-backend/src/middleware/limiter.middleware.ts`,
     `advancedLimiter.ts` — degrade to fail policy when Redis is unavailable.
   - Tests: `gateway-edge/rust-ext/src/redis_cb.rs` (17 cases),
     `gateway-control-plane/src/redis_cb.rs` (20 cases),
     `uam-backend/src/scripts/test-redis-circuit-breaker.ts` (18 scenarios,
     31 checks; `npm run test:cb`).
   - Load tests: `dev/tests/load_uam.js`, `dev/tests/load_control_plane.js`
     with runners `dev/scripts/load-test-uam.ps1`,
     `dev/scripts/load-test-control-plane.ps1` (k6 via Docker).

2. Redis call paths discovered.

   - gateway-edge (Rust FFI): token-version check and revocation check on the
     authenticated hot path (auth.rs); fleet-wide rate-limit counter sync on a
     background thread (rate_limit.rs). Both are the only Redis paths.
   - gateway-control-plane: admin nonce (request path, with in-memory
     fallback); `write_revocation_keys` (admin path, fails closed with 503);
     telemetry ingest is HTTP-only (no Redis).
   - uam-backend: cache pool (`runCacheCommand`) and rate-limit pool
     (`runRateLimitCommand`) — all user-facing auth endpoints go through one
     of these two, and therefore through the single process-wide breaker.

3. Circuit-breaker architecture.

   Local, process-local circuit breaker per instance (no Redis, no DB, no
   network for circuit state — §4, §27). Concepts separated (§2):
   operation → timeout/concurrency guard → health recorder (bounded
   histogram + counters) → health evaluator (fast + statistical detectors)
   → circuit (CLOSED/OPEN/HALF_OPEN) → degradation policy (decided by the
   caller, never inside the breaker — §17). Hot-path `acquire()` is a single
   atomic load (lock-free, no per-request allocation).

4. State-machine explanation.

   - CLOSED: requests allowed; every call records latency/outcome into the
     rolling window.
   - OPEN: normal calls are rejected immediately with `CIRCUIT_OPEN` (no
     Redis wait). After `open_cooldown_ms + jitter` elapses, the next attempt
     transitions to HALF_OPEN via CAS.
   - HALF_OPEN: only `half_open_probes` probes are dispatched; all other
     requests keep using degradation behavior. Each successful probe adds to
     `recovery_successes`; a probe failure re-opens immediately.
   - Recovery to CLOSED requires sustained evidence: `recovery_successes`
     consecutive successes AND rolling p99 ≤ recovery threshold AND error
     rate ≤ recovery threshold (§19).

5. Health metrics used.

   Rolling 1-second time buckets (fixed ring, ≤ 64 buckets, memory-bounded
   histogram with 18 latency bands — §6). Per window: total, errors,
   timeouts, latency histogram. Derived: error rate, timeout rate, p50/p95/
   p99 latency, consecutive failure/timeout counters.

6. Exact OPEN conditions.

   - Fast detector: consecutive failures ≥ `*_CONSECUTIVE_FAIL_OPEN` OR
     consecutive timeouts ≥ `*_CONSECUTIVE_TIMEOUT_OPEN`.
   - Statistical detector (only after ≥ `min_samples` observations):
     rolling error rate ≥ `*_ERROR_RATE_OPEN` OR rolling timeout rate ≥
     `*_TIMEOUT_RATE_OPEN` OR rolling p99 ≥ `*_P99_US_OPEN`.
   - HALF_OPEN probe failure/timeout always re-opens.

7. Exact HALF_OPEN conditions.

   OPEN + cooldown elapsed (base `*_OPEN_COOLDOWN_MS` + randomized
   `*_COOLDOWN_JITTER_MS`). Probe budget = `*_HALF_OPEN_PROBES`; probes
   beyond the budget are rejected with `CIRCUIT_OPEN`.

8. Exact CLOSED/recovery conditions.

   In HALF_OPEN: ≥ `*_RECOVERY_SUCCESSES` consecutive probe successes AND
   rolling p99 ≤ `*_P99_US_RECOVERY` AND rolling error rate ≤
   `*_ERROR_RATE_RECOVERY`.

9. Hysteresis behavior.

   Separate OPEN and RECOVERY thresholds (e.g. p99 open 200ms vs recovery
   30ms, error-rate open 0.5 vs recovery 0.1). A middling signal neither
   opens nor closes, preventing flapping (§12). Anti-flap tests exist in all
   three services.

10. Timeout behavior.

    Every breaker-protected Redis call has a bounded application-level
    deadline: edge `REDIS_AUTH_TIMEOUT_MS` (5–1000ms),
    `RATE_LIMIT_REDIS_TIMEOUT_MS` (5–500ms); control plane
    `CP_REDIS_TIMEOUT_MS` (50–5000ms); uam `REDIS_CONNECT_TIMEOUT_MS` +
    `REDIS_COMMAND_TIMEOUT_MS` wired into ioredis. Timeouts are recorded
    separately from generic errors (§8) and never block threads indefinitely.

11. Retry behavior.

    - Edge: exactly 2 attempts with backoff + jitter; NO retry on timeout
      (prevents retry amplification).
    - Control plane: deliberately single-shot (no retry loop) — documented in
      redis_cb.rs. Callers apply degradation (in-memory fallback / 503).
    - uam: ioredis bounded retries (`REDIS_MAX_RETRIES_PER_REQUEST`,
      exponential backoff capped at 5s, `REDIS_MAX_RECONNECT_ATTEMPTS`=20).
    All retries are bounded and never continue while the circuit is OPEN.

12. Concurrency-limit behavior.

    `max_inflight` caps concurrent Redis operations (CLOSED);
    `half_open_probes` caps HALF_OPEN concurrency. Rejections are
    `CONCURRENCY_REJECTED` and flow to the degradation layer. This prevents
    the slowdown→more-work→slower feedback loop (§15).

13. Metrics added.

    gateway-edge / control-plane (`redis_*`): `redis_requests_total`,
    `redis_success_total`, `redis_errors_total`, `redis_timeouts_total`,
    `redis_circuit_state`, `redis_circuit_open_total`,
    `redis_circuit_half_open_total`, `redis_circuit_rejected_total`,
    `redis_inflight_current`, `redis_latency_p50_us`, `redis_latency_p95_us`,
    `redis_latency_p99_us`, `redis_error_rate_rolling`.
    uam-backend: same set prefixed `uam_`. No high-cardinality labels.

14. Logs added.

    Only state transitions (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED,
    HALF_OPEN→OPEN) at INFO level with reason + cooldown; per-request
    failures are NOT logged at ERROR (no logging storm, §23). No secrets or
    Redis data logged.

15. Tests added.

    17 (edge) + 20 (control plane) Rust unit tests + 18 scenarios / 31
    checks (uam). Coverage: healthy stays CLOSED; single transient failure;
    consecutive-fail/timeout OPEN; error-rate/timeout-rate/p99 statistical
    OPEN; minimum-sample guard; OPEN rejects acquire; cooldown→HALF_OPEN;
    probe budget; successful recovery→CLOSED; failed probe→OPEN; hysteresis;
    jitter bounds; concurrency cap; Redis-timeout bounded; 8-thread
    concurrent isolation. All green; edge concurrency test stress-run 10/10.

16. Load tests performed.

    Existing gateway k6 suite (500 VU hot path) plus new k6 suites for
    control plane (ArcSwap `/config` + `/health`) and uam (`/ready` +
    `/health`) with runners. Note: no load test has yet been run against a
    live Redis outage on uam/control-plane; `dev/tests/chaos_test.ps1`
    (gateway) pauses Redis and asserts health/ready stay up.

17. Performance overhead measured if possible.

    Not measured on a live deployment. By design: CLOSED-path `acquire()` is
    one atomic load; the rolling-window histogram is touched once per
    completed Redis call under a short per-bucket mutex (only when the call
    already paid a network RTT); no per-request allocation. A live benchmark
    before/after on the edge hot path is a recommended follow-up.

18. Known limitations.

    - Percentiles are computed on demand from a fixed-width histogram, so
      they are approximate (bounded by the 18-band resolution), not exact.
    - Baseline-aware (relative) latency detection is NOT implemented; only
      absolute thresholds (§13 — documented as future work in all three
      implementations).
    - Distributed tracing (spans) is NOT implemented anywhere in the stack
      yet (§24 — see LGTM section).
    - uam `*_total` counters reset with the process (fine for Prometheus
      `rate()`, but long-lived instances only).
    - The statistical detector samples on `release()`; a burst that happens
      between two consecutive releases within one second is still captured by
      the fast detector (consecutive failures/timeouts).
    - Load-test results on live infrastructure and chaos-testing of
      uam/control-plane Redis outages are still outstanding.

19. Future improvements.

    - Baseline-aware latency (relative degradation) with bounded adaptive
      baseline.
    - OpenTelemetry spans for Redis operations (LGTM stack, §24).
    - Exact percentile sketches (HDR) if tighter latency estimates are needed.
    - Cross-service load + chaos testing for the breaker.
    - Grafana dashboards for the circuit-breaker/redis series (planned with
      LGTM).