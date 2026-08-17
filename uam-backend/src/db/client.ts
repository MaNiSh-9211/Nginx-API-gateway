import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config';
import { users, userIdentityIndexes } from './schema';

/**
 * PostgreSQL connection layer (replaces MongoDB/mongoose).
 *
 * Design:
 * - A single `pg` Pool per process (connectionString from DATABASE_URL).
 * - A Drizzle client built over the same pool for typed queries.
 * - A tiny hand-rolled migration runner (no drizzle-kit / external tooling)
 *   so `npm run build && npm start` works without a separate migrate step.
 *
 * SSL: Aiven free tier requires TLS. The server cert chain is self-signed
 * (not verifiable against public roots), so we use `rejectUnauthorized: false`.
 * For a fully managed instance where the root CA is trusted, flip PG_SSL_CERT.
 */
export const pool = new Pool({
    connectionString: config.postgres.url,
    max: config.postgres.pool.max,
    idleTimeoutMillis: config.postgres.pool.idleTimeoutMs,
    connectionTimeoutMillis: config.postgres.pool.connectTimeoutMs,
    ssl: config.postgres.ssl
        ? { rejectUnauthorized: false }
        : undefined,
    application_name: config.postgres.appName,
});

pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err.message);
});

pool.on('connect', () => {
    console.log('PostgreSQL driver pool ready');
});

export const db = drizzle(pool, { schema: { users, userIdentityIndexes } });
