import { NextFunction, Request, Response } from 'express';
import { redis, isRedisAvailable } from '../config/redis';
import { config } from '../config/index';
import { rateLimitConfig } from '../config/rateLimit.config';

const memoryStore: Record<string, { count: number; resetTime: number; blockUntil: number }> = {};
const LOGIN_PREFIX = 'login_attempt:';

function redisRequiredForLoginLimit(): boolean {
    return config.rateLimit.requireDistributed;
}

function rejectDistributedLimitUnavailable(res: Response): void {
    res.status(503).json({
        success: false,
        message: 'Authentication rate limiting temporarily unavailable',
    });
}

/**
 * Advanced Login Limiter with Exponential Backoff
 */
export const advancedLoginLimiter = async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip;
    const { email } = req.body;
    const key = `${LOGIN_PREFIX}${ip}_${email || 'unknown'}`;
    const now = Date.now();

    try {
        let record = { count: 0, blockUntil: 0 };

        if (isRedisAvailable() && redis) {
            const data = await redis.get(key);
            if (data) record = JSON.parse(data);
        } else if (redisRequiredForLoginLimit()) {
            rejectDistributedLimitUnavailable(res);
            return;
        } else if (memoryStore[key]) {
            record = memoryStore[key];
        }

        // Check if blocked
        if (record.blockUntil && record.blockUntil > now) {
            const remaining = Math.ceil((record.blockUntil - now) / 60000);
            res.status(429).json({
                success: false,
                message: `Too many failed attempts. Please try again in ${remaining} minutes.`,
                remainingTime: record.blockUntil - now
            });
            return;
        }

        // Attach tracker to request for controller to update on failure
        (req as any).rateLimitKey = key;
        (req as any).currentAttempts = record.count;

        next();
    } catch (error) {
        console.error('Rate limit error:', error);
        if (redisRequiredForLoginLimit()) {
            rejectDistributedLimitUnavailable(res);
            return;
        }
        const fallbackKey = `${LOGIN_PREFIX}${req.ip}_${req.body?.email || 'unknown'}`;
        const record = memoryStore[fallbackKey] ?? { count: 0, resetTime: 0, blockUntil: 0 };
        if (record.blockUntil && record.blockUntil > Date.now()) {
            const remaining = Math.ceil((record.blockUntil - Date.now()) / 60000);
            res.status(429).json({
                success: false,
                message: `Too many failed attempts. Please try again in ${remaining} minutes.`,
                remainingTime: record.blockUntil - Date.now(),
            });
            return;
        }
        (req as any).rateLimitKey = fallbackKey;
        (req as any).currentAttempts = record.count;
        next();
    }
};

/**
 * Handle Login Failure (Increment count & Apply exponential backoff)
 */
export const handleLoginFailure = async (req: Request) => {
    const key = (req as any).rateLimitKey;
    if (!key) return;

    const config = rateLimitConfig.login;
    let count = ((req as any).currentAttempts || 0) + 1;
    let blockUntil = 0;

    // Exponential Backoff Logic
    if (count > config.allowedAttempts) {
        if (count === config.allowedAttempts + 1) blockUntil = Date.now() + config.blockDuration.step1;
        else if (count === config.allowedAttempts + 2) blockUntil = Date.now() + config.blockDuration.step2;
        else blockUntil = Date.now() + config.blockDuration.step3;
    }

    const data = JSON.stringify({ count, blockUntil });

    if (isRedisAvailable() && redis) {
        const ttl = Math.ceil(config.blockDuration.step3 / 1000) + 600;
        await redis.setex(key, ttl, data);
    } else if (redisRequiredForLoginLimit()) {
        return null;
    } else {
        memoryStore[key] = { count, resetTime: 0, blockUntil };
        // Cleanup memory store simplified for now
    }

    return blockUntil > 0 ? blockUntil : null;
};

/**
 * Reset Login Attempts (On successful login)
 */
export const resetLoginAttempts = async (req: Request) => {
    const key = (req as any).rateLimitKey;
    if (!key) return;

    if (isRedisAvailable() && redis) {
        await redis.del(key);
    } else {
        delete memoryStore[key];
    }
};
