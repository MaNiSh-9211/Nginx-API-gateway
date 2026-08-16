import client from 'prom-client';
import { Request, Response, NextFunction } from 'express';

export const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'uam_' });

export const httpRequestsTotal = new client.Counter({
    name: 'uam_http_requests_total',
    help: 'Total HTTP requests handled by UAM backend',
    labelNames: ['method', 'route', 'status'],
    registers: [register],
});

export const httpRequestDuration = new client.Histogram({
    name: 'uam_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [register],
});

/** Collapse dynamic path segments to keep Prometheus cardinality bounded. */
export function normalizeRoute(req: Request): string {
    if (req.route?.path) {
        const base = req.baseUrl || '';
        return `${base}${req.route.path}`;
    }
    const normalized = req.path
        .replace(/\/[0-9a-f]{24}/gi, '/:id')
        .replace(/\/[0-9a-f-]{36}/gi, '/:id');
    const parts = normalized.split('/').filter(Boolean).slice(0, 4);
    return parts.length ? `/${parts.join('/')}` : '/';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const route = normalizeRoute(req);
        httpRequestsTotal.inc({
            method: req.method,
            route,
            status: String(res.statusCode),
        });
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        httpRequestDuration.observe({ method: req.method, route }, seconds);
    });
    next();
}

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
}
