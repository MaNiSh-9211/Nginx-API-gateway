import Redis, { RedisOptions } from 'ioredis';
import { config } from './index';

type RedisRole = 'cache' | 'ratelimit';

let redisCache: Redis | null = null;
let redisRateLimit: Redis | null = null;
let cacheReady = false;
let rateLimitReady = false;

function buildRedisOptions(role: RedisRole): RedisOptions {
    const { redis } = config;
    return {
        host: redis.host,
        port: redis.port,
        username: redis.username || undefined,
        password: redis.password || undefined,
        tls: redis.tls ? { servername: redis.host } : undefined,
        db: redis.db,
        connectionName: `uam-${role}`,
        lazyConnect: true,
        enableReadyCheck: true,
        enableOfflineQueue: true,
        maxRetriesPerRequest: redis.maxRetriesPerRequest,
        connectTimeout: redis.connectTimeoutMs,
        commandTimeout: redis.commandTimeoutMs,
        keepAlive: redis.keepAliveMs,
        retryStrategy: (times) => {
            if (times > redis.maxReconnectAttempts) {
                console.log(`⚠️ Redis (${role}): max reconnect attempts reached`);
                return null;
            }
            return Math.min(times * 200, 5_000);
        },
        reconnectOnError: (err) => {
            const message = err.message;
            return message.includes('READONLY') || message.includes('ECONNRESET');
        },
    };
}

function wireClientEvents(client: Redis, role: RedisRole, onReady: (ready: boolean) => void): void {
    client.on('ready', () => {
        onReady(true);
        console.log(`✅ Redis (${role}) ready`);
    });

    client.on('connect', () => {
        console.log(`Redis (${role}) TCP connected`);
    });

    client.on('error', (err) => {
        onReady(false);
        console.error(`❌ Redis (${role}) error:`, err.message);
    });

    client.on('close', () => {
        onReady(false);
        console.log(`⚠️ Redis (${role}) connection closed`);
    });

    client.on('reconnecting', () => {
        onReady(false);
    });
}

function createClients(): void {
    if (!config.redis.enabled) {
        console.log('ℹ️ Redis is disabled in configuration');
        return;
    }

    redisCache = new Redis(buildRedisOptions('cache'));
    wireClientEvents(redisCache, 'cache', (ready) => {
        cacheReady = ready;
    });

    // Dedicated connection for rate limiting — isolates counter churn from auth cache latency.
    redisRateLimit = new Redis(buildRedisOptions('ratelimit'));
    wireClientEvents(redisRateLimit, 'ratelimit', (ready) => {
        rateLimitReady = ready;
    });
}

createClients();

async function ensureRedisConnected(client: Redis): Promise<void> {
    if (client.status === 'ready') return;
    if (client.status === 'wait') {
        await client.connect();
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const finish = (err?: Error) => {
            client.off('ready', onReady);
            client.off('error', onError);
            if (err) reject(err);
            else resolve();
        };
        const onReady = () => finish();
        const onError = (e: Error) => finish(e);
        client.once('ready', onReady);
        client.once('error', onError);
    });
}

export const connectRedis = async (): Promise<void> => {
    if (!config.redis.enabled || !redisCache || !redisRateLimit) return;

    try {
        await Promise.all([
            ensureRedisConnected(redisCache),
            ensureRedisConnected(redisRateLimit),
        ]);
        await Promise.all([redisCache.ping(), redisRateLimit.ping()]);
        cacheReady = true;
        rateLimitReady = true;
        console.log('✅ Redis pools connected (cache + ratelimit)');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log('⚠️ Redis not available, continuing with degraded mode:', message);
        cacheReady = false;
        rateLimitReady = false;
    }
};

export const closeRedis = async (): Promise<void> => {
    const closes: Promise<'OK' | void>[] = [];
    if (redisCache) {
        closes.push(redisCache.quit().catch(() => redisCache?.disconnect()));
    }
    if (redisRateLimit) {
        closes.push(redisRateLimit.quit().catch(() => redisRateLimit?.disconnect()));
    }
    await Promise.all(closes);
    cacheReady = false;
    rateLimitReady = false;
    console.log('Redis pools closed');
};

export const pingRedisCache = async (): Promise<boolean> => {
    if (!redisCache || !cacheReady) return false;
    try {
        const pong = await redisCache.ping();
        return pong === 'PONG';
    } catch {
        return false;
    }
};

export const pingRedisRateLimit = async (): Promise<boolean> => {
    if (!redisRateLimit || !rateLimitReady) return false;
    try {
        const pong = await redisRateLimit.ping();
        return pong === 'PONG';
    } catch {
        return false;
    }
};

export const isRedisAvailable = (): boolean => {
    return config.redis.enabled && cacheReady && redisCache !== null;
};

export const isRedisRateLimitAvailable = (): boolean => {
    return config.redis.enabled && rateLimitReady && redisRateLimit !== null;
};

export const cacheSet = async (key: string, value: string, ttlSeconds?: number): Promise<void> => {
    if (!isRedisAvailable() || !redisCache) return;
    try {
        if (ttlSeconds) {
            await redisCache.setex(key, ttlSeconds, value);
        } else {
            await redisCache.set(key, value);
        }
    } catch {
        // Redis is an optional acceleration layer for some paths.
    }
};

export const cacheGet = async (key: string): Promise<string | null> => {
    if (!isRedisAvailable() || !redisCache) return null;
    try {
        return await redisCache.get(key);
    } catch {
        return null;
    }
};

export const cacheDel = async (key: string): Promise<void> => {
    if (!isRedisAvailable() || !redisCache) return;
    try {
        await redisCache.del(key);
    } catch {
        // best-effort
    }
};

/** Cache/session/oauth — backward-compatible export. */
export { redisCache as redis, redisRateLimit };
