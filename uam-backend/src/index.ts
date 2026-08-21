import { shutdownTelemetry } from './otel'; // must be imported before express (side-effect init)
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import passport from './config/passport';
import { config } from './config';
import { connectDatabase, disconnectDatabase, pingDatabase } from './config/database';
import { connectRedis, closeRedis, pingRedisCache, redisRateLimit } from './config/redis';
import { assertDistributedRateLimitReady } from './middleware/limiter.middleware';
import authRoutes from './routes/auth.routes';
import migrationRoutes from './routes/migration.routes';
import profileRoutes from './routes/profile.routes';
import { metricsHandler, metricsMiddleware } from './metrics';
import { apiLimiter, authLimiter, loginLimiter, RateLimiterUnavailableError, type RateLimitResult } from './robustRateLimiter';
import { warnIfInsecurePepper } from './utils/password.util';
import { warnIfInsecureSecrets } from './utils/secrets.util';

warnIfInsecurePepper();
warnIfInsecureSecrets();

const app = express();

app.set('trust proxy', 1);

function requireMetricsAuth(req: Request, res: Response, next: NextFunction): void {
    const token = config.metricsToken;
    if (!token) {
        next();
        return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return;
    }
    next();
}

// Probes and metrics scrapers do not send Origin — register before CORS.
app.get('/health', async (req, res) => {
    const rateState = apiLimiter.getState();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      rateLimiting: rateState.redisAvailable ? 'distributed' : 'local fallback',
      redis: rateState.redisAvailable ? 'connected' : 'fallback',
    });
});

/** Readiness — Postgres pool + Redis cache must answer before accepting traffic (K8s). */
app.get('/ready', async (_req, res) => {
    const dbOk = await pingDatabase();
    const redisRequired = config.redis.enabled;
    const redisOk = redisRequired ? await pingRedisCache() : true;

    if (dbOk && redisOk) {
        res.json({
            status: 'ready',
            postgres: true,
            redis: redisRequired ? true : 'disabled',
            timestamp: new Date().toISOString(),
        });
        return;
    }

    res.status(503).json({
        status: 'not_ready',
        postgres: dbOk,
        redis: redisRequired ? redisOk : 'disabled',
        timestamp: new Date().toISOString(),
    });
});

app.get('/metrics', requireMetricsAuth, metricsHandler);

app.use(
    cors({
        origin: (origin, callback) => {
            if (config.nodeEnv === 'development') {
                return callback(null, true);
            }
            // Non-browser clients (curl, health probes) omit Origin; CORS does not apply to them.
            if (!origin) {
                return callback(null, true);
            }
            const allowedOrigins = [
                'http://localhost:5173',
                'http://127.0.0.1:5173',
                'http://localhost:5174',
                'http://127.0.0.1:5174',
                'http://localhost:3000',
                'http://localhost:8091',
                'http://127.0.0.1:8091',
                config.clientUrl,
            ];
            if (allowedOrigins.indexOf(origin) !== -1) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-CSRF-Token'],
        exposedHeaders: ['Content-Type', 'Authorization'],
        preflightContinue: false,
        optionsSuccessStatus: 204,
    }),
);

app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        crossOriginEmbedderPolicy: false,
    }),
);

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use(cookieParser());
app.use(passport.initialize());

app.use(metricsMiddleware);

// Apply rate limiting per-path for flexibility
// Distributed rate limiting via Redis — runtime failures degrade to local
// memory ONLY when RATE_LIMIT_LOCAL_FALLBACK=1; with =0 the request fails
// closed with 503 (fleet-wide limits are never silently weakened).
app.use('/api/', async (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip || 'unknown';
    let rateResult: RateLimitResult;
    try {
        rateResult = await apiLimiter.checkLimit(clientId);
    } catch (err) {
        if (err instanceof RateLimiterUnavailableError) {
            return res.status(503).json({
                error: 'Rate limiter unavailable',
                retryAfter: new Date(Date.now() + 5000).toISOString(),
            });
        }
        throw err;
    }

    if (!rateResult.allowed) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: new Date(rateResult.resetAt).toISOString(),
        limit: 'api',
        remaining: rateResult.remaining,
      });
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Remaining', rateResult.remaining.toString());
    res.setHeader('X-RateLimit-Reset', rateResult.resetAt.toString());
    res.setHeader('X-RateLimit-Limit', String(apiLimiter.getState().redisAvailable ? 'Distributed' : 'Local'));
    next();
});

app.use('/api/auth', authRoutes);

// Apply stricter auth rate limiting
app.use('/api/auth/login', async (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip || 'unknown';
    let rateResult: RateLimitResult;
    try {
        rateResult = await authLimiter.checkLimit(clientId);
    } catch (err) {
        if (err instanceof RateLimiterUnavailableError) {
            return res.status(503).json({
                error: 'Rate limiter unavailable',
                retryAfter: new Date(Date.now() + 5000).toISOString(),
            });
        }
        throw err;
    }

    if (!rateResult.allowed) {
      return res.status(429).json({
        error: 'Too many login attempts',
        retryAfter: new Date(rateResult.resetAt).toISOString(),
        limit: 'auth',
        remaining: rateResult.remaining,
      });
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Remaining', rateResult.remaining.toString());
    res.setHeader('X-RateLimit-Reset', rateResult.resetAt.toString());
    res.setHeader('X-RateLimit-Limit', '5');
    next();
});
app.use('/api/auth/migrate', migrationRoutes);
app.use('/api/auth/profile', profileRoutes);

app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Error:', err);
    const isCors = err.message === 'Not allowed by CORS';
    res.status(isCors ? 403 : 500).json({
        success: false,
        message: config.nodeEnv === 'development' && !isCors ? err.message : isCors ? 'Forbidden' : 'Internal server error',
    });
});

const startServer = async (): Promise<void> => {
    try {
        await connectDatabase();

        // Connect Redis — if unavailable, connectRedis will handle it
        // assertDistributedRateLimitReady() will exit(1) if distributed limits required but Redis down
        await assertDistributedRateLimitReady();

        // Wire the rate-limit pool into the limiters (they are unusable without it)
        if (!redisRateLimit) {
            console.error('FATAL: Redis rate-limit pool unavailable — distributed limiting required');
            process.exit(1);
        }
        apiLimiter.setRedisClient(redisRateLimit);
        authLimiter.setRedisClient(redisRateLimit);
        loginLimiter.setRedisClient(redisRateLimit);

        // Initialize the limiter's own health flag (ping + fallback state);
        // without this, /health reports "local fallback" even when Redis works.
        await apiLimiter.init().catch(() => { /* strict mode exits inside init */ });

        const server = app.listen(config.port, '0.0.0.0', () => {
            console.log(`UAM backend listening on port ${config.port} (${config.nodeEnv})`);
            const rateState = apiLimiter.getState();
            const mode = rateState.redisAvailable
                ? 'Distributed (Redis)'
                : rateState.allowFallback
                    ? 'Local fallback (memory)'
                    : 'STRICT — Redis required, no local fallback';
            console.log(`Rate limiting: ${mode}`);
        });

        const shutdown = async (signal: string) => {
            console.log(`${signal} received — draining connections`);
            server.close();
            await closeRedis();
            await disconnectDatabase();
            await shutdownTelemetry();
            process.exit(0);
        };

        process.on('SIGTERM', () => void shutdown('SIGTERM'));
        process.on('SIGINT', () => void shutdown('SIGINT'));
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

startServer();