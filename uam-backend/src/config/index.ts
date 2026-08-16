import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { envBool, envInt } from './env.util';

// .env = safe defaults (committed). .env.dev = secrets (gitignored), overrides when present.
dotenv.config();
const devEnv = resolve(process.cwd(), '.env.dev');
if (existsSync(devEnv)) {
    dotenv.config({ path: devEnv, override: true });
}

export const config = {
    port: parseInt(process.env.PORT || '8080', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/uam',
        /** Driver connection pool — one pool per Node process (ADR production defaults). */
        pool: {
            maxPoolSize: envInt('MONGODB_MAX_POOL_SIZE', 50),
            minPoolSize: envInt('MONGODB_MIN_POOL_SIZE', 5),
            maxIdleTimeMS: envInt('MONGODB_MAX_IDLE_TIME_MS', 60_000),
            waitQueueTimeoutMS: envInt('MONGODB_WAIT_QUEUE_TIMEOUT_MS', 10_000),
            serverSelectionTimeoutMS: envInt('MONGODB_SERVER_SELECTION_TIMEOUT_MS', 5_000),
            socketTimeoutMS: envInt('MONGODB_SOCKET_TIMEOUT_MS', 45_000),
            connectTimeoutMS: envInt('MONGODB_CONNECT_TIMEOUT_MS', 10_000),
            heartbeatFrequencyMS: envInt('MONGODB_HEARTBEAT_FREQUENCY_MS', 10_000),
            retryWrites: envBool('MONGODB_RETRY_WRITES', true),
            retryReads: envBool('MONGODB_RETRY_READS', true),
            appName: process.env.MONGODB_APP_NAME || 'uam-backend',
        },
    },

    redis: {
        enabled: process.env.REDIS_ENABLED !== 'false',
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        username: process.env.REDIS_USERNAME || undefined,
        password: process.env.REDIS_PASSWORD || '',
        tls: process.env.REDIS_TLS === 'true',
        db: envInt('REDIS_DB', 0),
        connectTimeoutMs: envInt('REDIS_CONNECT_TIMEOUT_MS', 10_000),
        commandTimeoutMs: envInt('REDIS_COMMAND_TIMEOUT_MS', 5_000),
        keepAliveMs: envInt('REDIS_KEEPALIVE_MS', 30_000),
        maxRetriesPerRequest: envInt('REDIS_MAX_RETRIES_PER_REQUEST', 3),
        maxReconnectAttempts: envInt('REDIS_MAX_RECONNECT_ATTEMPTS', 20),
    },

    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET || 'default-access-secret',
        refreshSecret: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret',
        accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
        issuer: process.env.JWT_ISSUER || 'api-gateway-auth-server',
        audience: process.env.JWT_AUDIENCE || 'api-gateway-clients',
    },

    security: {
        passwordPepper: process.env.PASSWORD_PEPPER || '',
        defaultHomeRegion: process.env.DEFAULT_HOME_REGION || 'US',
        // Dev/docker only — skip email verification gate (never enable in production).
        autoVerifyEmail:
            process.env.AUTO_VERIFY_EMAIL === '1'
            || process.env.AUTO_VERIFY_EMAIL === 'true',
    },

    google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
        callbackUrl: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:5000/api/auth/google/callback',
    },

    github: {
        clientId: process.env.GITHUB_CLIENT_ID || '',
        clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
        callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:5000/api/auth/github/callback',
    },

    smtp: {
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
    },

    clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',

    cookies: {
        secure:
            process.env.COOKIE_SECURE === '1'
            || process.env.COOKIE_SECURE === 'true',
        sameSite: (process.env.COOKIE_SAME_SITE || 'strict') as 'strict' | 'lax' | 'none',
        path: process.env.COOKIE_PATH || '/api/auth',
    },

    auth: {
        /** Browser clients use HttpOnly cookies; omit refresh from JSON (ADR-0055). */
        omitRefreshInBody:
            process.env.AUTH_OMIT_REFRESH_IN_BODY === '1'
            || process.env.AUTH_OMIT_REFRESH_IN_BODY === 'true',
    },

    oauth: {
        googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        githubEnabled: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    },

    /** Auth rate limits must use Redis when scaling beyond one pod (Helm replicas > 1). */
    rateLimit: {
        requireDistributed:
            process.env.UAM_REQUIRE_DISTRIBUTED_RATE_LIMIT === '1'
            || process.env.UAM_REQUIRE_DISTRIBUTED_RATE_LIMIT === 'true'
            || (
                (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging')
                && process.env.UAM_RELAX_AUTH_LIMITS !== '1'
                && process.env.UAM_RELAX_AUTH_LIMITS !== 'true'
            ),
    },

    /** Control plane — publishes gateway access-token revocations (ADR-0039). */
    controlPlane: {
        url: process.env.CONTROL_PLANE_URL || 'http://control-plane:8081',
        adminApiKey: process.env.ADMIN_API_KEY || 'change_me_in_production',
    },

    /** Bearer token required for GET /metrics in production (empty = dev-only open scrape). */
    metricsToken: process.env.METRICS_TOKEN || '',
};
