import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

function createRedisClient() {
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
  const redisUsername = process.env.REDIS_USERNAME || undefined;
  const redisPassword = process.env.REDIS_PASSWORD || undefined;
  const redisTls = process.env.REDIS_TLS === 'true';
  const redisDb = parseInt(process.env.REDIS_DB || '0', 10);

  // Build primary Redis URL
  const primaryUrl = redisTls
    ? `rediss://${redisUsername}:${redisPassword}@${redisHost}:${redisPort}`
    : `redis://${redisUsername}:${redisPassword}@${redisHost}:${redisPort}`;

  const redisOptions: RedisOptions = {
    maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES_PER_REQUEST || '3', 10),
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '10000', 10),
    commandTimeout: parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS || '5000', 10),
    keepAlive: parseInt(process.env.REDIS_KEEPALIVE_MS || '30000', 10),
    db: redisDb,
  };

  const primaryRedis = new Redis(primaryUrl, redisOptions);

  primaryRedis.on('error', (err: Error) => {
    console.warn('Redis primary connection error:', err.message);
  });

  // No fallback Redis - if primary is down, connection will fail
  const wrapper: any = { ...primaryRedis };

  wrapper.connect = async () => {
    try {
      await primaryRedis.connect();
      return primaryRedis;
    } catch (primaryError) {
      // No fallback - throw the error
      throw primaryError;
    }
  };

  wrapper.disconnect = async () => {
    try { await primaryRedis.quit(); } catch {}
  };

  wrapper.execute = async <T>(command: string, ...args: any[]): Promise<T> => {
    try {
      return await (primaryRedis as any)[command](...args);
    } catch (error) {
      throw error;
    }
  };

  return wrapper;
}

export default createRedisClient();
export type { RedisOptions };