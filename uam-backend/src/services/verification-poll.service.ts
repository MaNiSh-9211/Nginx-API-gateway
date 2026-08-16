/**
 * Opaque poll tokens for email verification status — avoids email enumeration (ADR-0062).
 *
 * Register returns a poll token; only POST /verification-status with that token
 * reveals whether the account is verified. Public email lookups always return false.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';
import { cacheDel, cacheGet, cacheSet, isRedisAvailable } from '../config/redis';
import { config } from '../config';

const POLL_TTL_SECS = 86_400; // 24h — matches email verification window
const POLL_BYTES = 32;
const REDIS_PREFIX = 'uam:verify-poll:';

const memoryPolls = new Map<string, { userId: string; exp: number }>();

function pruneMemoryPolls(): void {
    const now = Date.now();
    for (const [k, v] of memoryPolls) {
        if (v.exp <= now) memoryPolls.delete(k);
    }
}

export async function createVerificationPollToken(
    userId: mongoose.Types.ObjectId | string,
): Promise<string> {
    const token = crypto.randomBytes(POLL_BYTES).toString('hex');
    const id = userId.toString();

    if (isRedisAvailable()) {
        await cacheSet(`${REDIS_PREFIX}${token}`, id, POLL_TTL_SECS);
        return token;
    }

    if (config.nodeEnv === 'production') {
        throw new Error('Redis required for verification poll tokens in production');
    }

    pruneMemoryPolls();
    memoryPolls.set(token, { userId: id, exp: Date.now() + POLL_TTL_SECS * 1000 });
    return token;
}

export async function resolveVerificationPollToken(
    token: string,
): Promise<string | null> {
    if (!token || token.length < POLL_BYTES * 2) return null;

    if (isRedisAvailable()) {
        const userId = await cacheGet(`${REDIS_PREFIX}${token}`);
        return userId ?? null;
    }

    const entry = memoryPolls.get(token);
    if (!entry || entry.exp < Date.now()) {
        memoryPolls.delete(token);
        return null;
    }
    return entry.userId;
}

export async function revokeVerificationPollToken(token: string): Promise<void> {
    if (!token) return;
    if (isRedisAvailable()) {
        await cacheDel(`${REDIS_PREFIX}${token}`);
        return;
    }
    memoryPolls.delete(token);
}
