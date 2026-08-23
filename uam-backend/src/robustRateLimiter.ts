import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

export interface RateLimitRecord {
  count: number;
  resetAt: number;
  lastReset: number;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Thrown at request time when Redis is unhealthy and local fallback is
 * disabled (`RATE_LIMIT_LOCAL_FALLBACK=0`). Callers must map this to 503.
 */
export class RateLimiterUnavailableError extends Error {
    constructor(message = 'Rate limiter unavailable: Redis down and local fallback disabled') {
        super(message);
        this.name = 'RateLimiterUnavailableError';
    }
}

/**
 * `RATE_LIMIT_LOCAL_FALLBACK` — whether the limiter may degrade to in-memory
 * counting when Redis is unreachable.
 *   1 / true  (default) → graceful degradation to per-process memory limits
 *   0 / false           → STRICT: no silent degradation. Boot fails if Redis
 *                         is down; runtime failures return 503 to clients so
 *                         fleet-wide limits are never silently weakened.
 */
export function localFallbackEnabled(): boolean {
    const raw = (process.env.RATE_LIMIT_LOCAL_FALLBACK ?? '1').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/**
 * Distributed Rate Limiter with Redis
 * - On init: if Redis unavailable, throws (causes process.exit via assertDistributedRateLimitReady)
 * - On runtime Redis failure: falls back to local rate limiting — OR, when
 *   `RATE_LIMIT_LOCAL_FALLBACK=0`, fails closed with RateLimiterUnavailableError.
 */
export class RobustRateLimiter {
  private redis!: Redis;
  private config: {
    windowMs: number;
    maxRequests: number;
    keyPrefix: string;
  };
  private localCache: Map<string, RateLimitRecord> = new Map();
  private fallback: boolean = false;
  private initialized: boolean = false;
  private readonly allowFallback: boolean;
  private lastRecoveryProbeMs: number = 0;

  constructor(config: {
    windowMs: number;
    maxRequests: number;
    keyPrefix: string;
  }) {
    this.config = config;
    this.allowFallback = localFallbackEnabled();
  }

  /**
   * Inject the shared rate-limit Redis pool. Must be called during startup
   * (after connectRedis) — without it every limiter operation would fail. */
  setRedisClient(client: Redis): void {
    this.redis = client;
  }

  /**
   * Initialize and check Redis health. The ping is retried with backoff so a
   * managed-Redis cold start (Upstash can take >5 s on first hop) is not
   * mistaken for a hard outage. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const attempts = 5;
    let lastError: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.promiseWithTimeout(this.redis.ping(), 5000);
        console.log('✅ Redis connected - using distributed rate limiting');
        this.fallback = false;
        return;
      } catch (error) {
        lastError = error;
        if (i < attempts) {
          const backoffMs = i * 2000;
          console.warn(`⚠️ Redis health check ${i}/${attempts} failed (${(error as Error).message}) — retrying in ${backoffMs}ms`);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    if (!this.allowFallback) {
      console.error(`❌ FATAL: Redis unavailable after ${attempts} attempts and RATE_LIMIT_LOCAL_FALLBACK=0 — refusing to start (no silent local limiting)`);
      process.exit(1);
    }
    console.error('❌ Redis unavailable at startup - cannot start service');
    this.fallback = true;
    // We don't populate local cache here - let the startup flow handle it
    throw lastError; // Re-throw to cause process.exit
  }

  /**
   * Helper: timeout promise */
  private promiseWithTimeout<promiseValue>(promise: Promise<promiseValue>, ms: number): Promise<promiseValue> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<promiseValue>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /**
   * Check rate limit - works with Redis OR local fallback on runtime error */
  async checkLimit(clientIdentifier: string): Promise<RateLimitResult> {
    // If fallback, use local memory-based limiting (permissive mode only).
    if (this.fallback) {
      if (!this.allowFallback) {
        throw new RateLimiterUnavailableError();
      }
      await this.tryRecoverFromFallback();
      if (this.fallback) {
        return this.localRateLimit(clientIdentifier);
      }
    }

    // Try Redis-based distributed limiting
    return this.distributedRateLimit(clientIdentifier);
  }

  /**
   * Permissive mode only: every 30 s while degraded, probe Redis and clear the
   * fallback flag once it answers — a one-way trip into local mode otherwise
   * hides fleet-wide drift forever. */
  private async tryRecoverFromFallback(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecoveryProbeMs < 30_000) return;
    this.lastRecoveryProbeMs = now;
    try {
      await this.promiseWithTimeout(this.redis.ping(), 3000);
      console.log('✅ Redis recovered — leaving local fallback, restoring distributed limiting');
      this.fallback = false;
    } catch {
      // Still down — stay local until the next probe.
    }
  }

  /**
   * Runtime degradation point. STRICT mode never degrades: it fails the
   * request so callers surface a 503 instead of silently weakening limits. */
  private degradeToLocal(clientIdentifier: string): Promise<RateLimitResult> {
    if (!this.allowFallback) {
      throw new RateLimiterUnavailableError();
    }
    this.fallback = true;
    return this.localRateLimit(clientIdentifier);
  }

  /// Expired-window entries were never evicted — a flood of unique IPs in
  /// fallback mode grew this map without bound (OOM vector). Swept lazily:
  /// at most once per minute, only when the map is non-trivial.
  private lastSweepMs: number = 0;
  private sweepExpiredWindows(): void {
    const now = Date.now();
    if (this.localCache.size < 4_096 || now - this.lastSweepMs < 60_000) return;
    this.lastSweepMs = now;
    for (const [key, rec] of this.localCache) {
      if (rec.resetAt < now) this.localCache.delete(key);
    }
  }

  /**
   * Local rate limiting fallback (no Redis) */
  private async localRateLimit(clientIdentifier: string): Promise<RateLimitResult> {
    this.sweepExpiredWindows();
    const cacheKey = `rate_limit:local:${clientIdentifier}`;
    const cacheEntry = this.localCache.get(cacheKey) || {
      count: 0,
      resetAt: Date.now() + this.config.windowMs,
      lastReset: Date.now(),
      maxRequests: this.config.maxRequests || 10,
      windowMs: this.config.windowMs || 60000,
    };

    const now = Date.now();

    // Reset window if expired
    if (now > cacheEntry.resetAt) {
      cacheEntry.count = 0;
      cacheEntry.resetAt = now + this.config.windowMs;
      cacheEntry.lastReset = now;
    }

    // Increment counter
    cacheEntry.count++;
    this.localCache.set(cacheKey, cacheEntry);

    const remaining = this.config.maxRequests - cacheEntry.count;
    const isAllowed = cacheEntry.count <= this.config.maxRequests;

    return {
      allowed: isAllowed,
      remaining: remaining > 0 ? remaining : 0,
      resetAt: cacheEntry.resetAt,
    };
  }

  /**
   * Distributed rate limiting via Redis */
  private async distributedRateLimit(clientIdentifier: string): Promise<RateLimitResult> {
    const { windowMs, maxRequests, keyPrefix: prefix } = this.config;
    const now = Math.floor(Date.now() / windowMs) * windowMs;
    const redisKey = `${prefix}:${clientIdentifier}`;

    // Use Redis pipeline for atomic operations
    const pipeline = this.redis.pipeline();

    // INCR - increment counter, returns new count
    pipeline.incr(redisKey);

    // EXPIRE - set key expiry on first request
    pipeline.expireat(redisKey, Math.ceil((Date.now() + windowMs) / 1000));

    // GET - get current count
    pipeline.get(redisKey);

    const results = await pipeline.exec();

    // pipeline.exec() returns Array<[error, result]> | null
    // If null or empty, degrade (or fail closed in strict mode)
    if (!results || results.length === 0) {
      console.warn('Redis pipeline returned no results, degrading rate limiter');
      return this.degradeToLocal(clientIdentifier);
    }

    // Check for errors in the first command's result
    const [err, countResult] = results[0] as [Error | null, unknown];
    if (err) {
      console.warn('Redis error in distributed limiter, degrading:', err.message);
      return this.degradeToLocal(clientIdentifier);
    }

    // countResult is a string from the GET command
    const countStr = countResult as string | number | null | undefined;
    const currentCount = parseInt(String(countStr) || '0', 10);
    const remaining = maxRequests - currentCount;
    const isAllowed = currentCount <= maxRequests;

    return {
      allowed: isAllowed,
      remaining: remaining > 0 ? remaining : 0,
      resetAt: now + windowMs,
    };
  }

  /**
   * Reset rate limit for a client */
  async resetLimit(clientIdentifier: string): Promise<boolean> {
    if (this.fallback) {
      const cacheKey = `rate_limit:local:${clientIdentifier}`;
      this.localCache.delete(cacheKey);
      return true;
    }

    try {
      await this.redis.del(`rate_limit:${clientIdentifier}`);
      return true;
    } catch (error) {
      console.error('Failed to reset rate limit:', error);
      if (!this.allowFallback) {
        throw new RateLimiterUnavailableError();
      }
      this.fallback = true;
      const cacheKey = `rate_limit:local:${clientIdentifier}`;
      this.localCache.delete(cacheKey);
      return false;
    }
  }

  /**
   * Get current state */
  getState(): {
    fallback: boolean;
    redisAvailable: boolean;
    allowFallback: boolean;
    config: {
      windowMs: number;
      maxRequests: number;
      keyPrefix: string;
    };
  } {
    return {
      fallback: this.fallback,
      redisAvailable: !this.fallback && this.initialized,
      allowFallback: this.allowFallback,
      config: this.config,
    };
  }

  /**
   * Graceful shutdown */
  async disconnect(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {}
  }
}

/**
 * Pre-configured limiters
 */
export const authLimiter = new RobustRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'rate_limit:auth',
});

export const apiLimiter = new RobustRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 100,
  keyPrefix: 'rate_limit:api',
});

export const loginLimiter = new RobustRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  keyPrefix: 'rate_limit:login',
});