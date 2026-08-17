import rateLimit, { type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisRateLimit, isRedisRateLimitAvailable, runRateLimitCommand } from '../config/redis';
import { config } from '../config/index';
import { rateLimitConfig } from '../config/rateLimit.config';

const relaxAuthLimits = config.nodeEnv !== 'production' && (
    process.env.UAM_RELAX_AUTH_LIMITS === '1'
    || process.env.UAM_RELAX_AUTH_LIMITS === 'true'
);

let storeModeLogged = false;

/** Fail-closed store when Redis is down but distributed limits are required. */
class FailClosedRateLimitStore implements Store {
    async increment(_key: string): Promise<{ totalHits: number; resetTime: Date }> {
        return { totalHits: Number.MAX_SAFE_INTEGER, resetTime: new Date(Date.now() + 60_000) };
    }

    async decrement(_key: string): Promise<void> {}

    async resetKey(_key: string): Promise<void> {}
}

// Each limiter needs its own RedisStore prefix so counters do not collide on the same IP key.
const getStore = (prefix: string): Store | undefined => {
    if (config.redis.enabled && redisRateLimit) {
        if (!storeModeLogged) {
            console.log('⚡ Rate Limiting: Redis Store (distributed across UAM replicas)');
            storeModeLogged = true;
        }
        return new RedisStore({
            prefix,
            // @ts-ignore - ioredis call signature matches what rate-limit-redis expects
            sendCommand: (...args: string[]): Promise<unknown> => {
                // Route through the local Redis circuit breaker. When the
                // circuit is OPEN/slow the breaker rejects immediately and we
                // fail closed (request errors) rather than buffering commands
                // against a degraded dependency (§17). The command is created
                // inside the callback so an OPEN circuit never dispatches it.
                return runRateLimitCommand<unknown>(() => {
                    // @ts-ignore - ioredis call signature matches what rate-limit-redis expects
                    return redisRateLimit!.call(...args);
                }).then((res) => {
                    if (!res.ok) {
                        throw new Error(`redis circuit ${res.outcome}`);
                    }
                    return res.value;
                });
            },
        });
    }

    if (config.rateLimit.requireDistributed) {
        if (!storeModeLogged) {
            console.log('🛑 Rate Limiting: fail-closed (Redis required, unavailable)');
            storeModeLogged = true;
        }
        return new FailClosedRateLimitStore();
    }

    if (!storeModeLogged) {
        console.log('📝 Rate Limiting: in-memory store (single-instance dev only)');
        storeModeLogged = true;
    }
    return undefined;
};

/** Abort boot if production expects fleet-wide limits but Redis rate-limit pool is down. */
export function assertDistributedRateLimitReady(): void {
    if (!config.rateLimit.requireDistributed) return;
    if (!config.redis.enabled) {
        console.error('FATAL: UAM_REQUIRE_DISTRIBUTED_RATE_LIMIT set but REDIS_ENABLED=false');
        process.exit(1);
    }
    if (!isRedisRateLimitAvailable()) {
        console.error('FATAL: Redis rate-limit pool not ready — distributed limits require Redis');
        process.exit(1);
    }
    console.log('✅ Distributed rate limiting ready (Redis)');
}
// General API Limiter - 1000 requests per minute (very generous for development)
export const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    store: getStore('rl:api:'),
    message: {
        success: false,
        message: 'Too many requests from this IP, please try again after 15 minutes.',
    },
});

// Strict Auth Limiter - Fallback for other auth routes
export const authLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: relaxAuthLimits ? 10_000 : 20,
    standardHeaders: true,
    legacyHeaders: false,
    store: getStore('rl:auth:'),
    message: {
        success: false,
        message: 'Too many authentication attempts, please try again after an hour.',
    },
});

// Email Existence Check Limiter
export const emailCheckLimiter = rateLimit({
    windowMs: rateLimitConfig.emailCheck.windowMs,
    limit: rateLimitConfig.emailCheck.limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: getStore('rl:email:'),
    message: {
        success: false,
        message: 'Too many email checks, please slow down.',
    },
});

// Password Reset Limiter
export const passwordResetLimiter = rateLimit({
    windowMs: rateLimitConfig.passwordReset.windowMs,
    limit: relaxAuthLimits ? 10_000 : rateLimitConfig.passwordReset.limitPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
    store: getStore('rl:pwd:'),
    message: {
        success: false,
        message: 'Too many password reset requests, please try again after 12 hours.',
    },
});

// Refresh + logout — limit brute-force of refresh tokens
export const sessionLimiter = rateLimit({
    windowMs: rateLimitConfig.session.windowMs,
    limit: relaxAuthLimits ? 10_000 : rateLimitConfig.session.limit,
    standardHeaders: true,
    legacyHeaders: false,
    store: getStore('rl:session:'),
    message: {
        success: false,
        message: 'Too many session requests, please slow down.',
    },
});

// Email migration — init/verify/resend (ADR-0063)
export const migrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: relaxAuthLimits ? 10_000 : 15,
    standardHeaders: true,
    legacyHeaders: false,
    store: getStore('rl:migrate:'),
    message: {
        success: false,
        message: 'Too many migration requests, please try again later.',
    },
});
