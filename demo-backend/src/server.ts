/**
 * Backend Test Service — sample upstream + dev JWT minter (dev only).
 */

import crypto from 'crypto';
import os from 'os';
import express, { Request, Response } from 'express';
import {
    registerUser,
    authenticateUser,
    warnInsecurePepper,
    getPepper,
} from './users';

const PORT = parseInt(process.env.PORT || '8080', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const EXPECTED_ISSUER = process.env.EXPECTED_ISSUER || 'api-gateway-auth-server';
const EXPECTED_AUDIENCE = process.env.EXPECTED_AUDIENCE || 'api-gateway-clients';
const AUTH_DEV_TOKENS = process.env.AUTH_DEV_TOKENS !== '0';
const HOSTNAME = os.hostname();

const app = express();
app.use(express.json({ limit: '64kb' }));
app.disable('x-powered-by');

function b64url(input: string): string {
    return Buffer.from(input)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

interface JwtClaims {
    sub: string;
    home_region: string;
    iss: string;
    aud: string;
    iat: number;
    nbf: number;
    exp: number;
    jti: string;
}

function mintJwt({
    sub,
    homeRegion,
    jti,
    ttlSecs,
}: {
    sub: string;
    homeRegion: string;
    jti?: string;
    ttlSecs?: number;
}): { token: string; claims: JwtClaims } {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload: JwtClaims = {
        sub,
        home_region: homeRegion,
        iss: EXPECTED_ISSUER,
        aud: EXPECTED_AUDIENCE,
        iat: now,
        nbf: now,
        exp: now + (ttlSecs || 3600),
        jti: jti || crypto.randomUUID(),
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(signingInput)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
    return { token: `${signingInput}.${signature}`, claims: payload };
}

function identityFrom(req: Request) {
    return {
        user_id: req.get('x-user-id') || null,
        home_region: req.get('x-home-region') || null,
        served_by: HOSTNAME,
        served_region: process.env.SERVICE_REGION || null,
        request_id: req.get('x-request-id') || null,
        traceparent: req.get('traceparent') || null,
    };
}

app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'backend-test-service', host: HOSTNAME });
});

app.get('/', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Demo API</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1e293b}
a{color:#2563eb}code{background:#f1f5f9;padding:.2em .4em;border-radius:4px}</style></head>
<body><h1>Demo API</h1><p>Sample upstream behind the API gateway.</p>
<ul><li><a href="/health">/health</a></li><li><code>GET /api/v1/users</code> (auth)</li></ul>
<p>UI: <a href="http://localhost:8090">demo frontend</a> · Auth: <a href="http://localhost:8091">UAM</a></p>
</body></html>`);
});

app.get('/public/status', (req, res) => {
    res.json({
        service: 'public-service',
        message: 'This endpoint requires no authentication.',
        identity: identityFrom(req),
        time: new Date().toISOString(),
    });
});

app.get('/api/v1/users', (req, res) => {
    res.json({
        resource: 'users',
        identity: identityFrom(req),
        data: [
            { id: 'u-1001', name: 'Ada Lovelace', region: 'EU' },
            { id: 'u-1002', name: 'Grace Hopper', region: 'US' },
            { id: 'u-1003', name: 'Radia Perlman', region: 'US' },
        ],
    });
});

app.get('/api/v1/orders', (req, res) => {
    res.json({
        resource: 'orders',
        identity: identityFrom(req),
        data: [
            { id: 'o-9001', total: 42.5, currency: 'EUR', status: 'shipped' },
            { id: 'o-9002', total: 19.0, currency: 'USD', status: 'pending' },
        ],
    });
});

app.post('/auth/register', async (req, res) => {
    try {
        const body = req.body || {};
        const username = String(body.username || body.sub || '').trim();
        const password = String(body.password || '');
        const homeRegion = String(body.home_region || 'US');
        const result = await registerUser({
            username,
            password,
            homeRegion,
            pepper: getPepper(),
        });
        if (!result.ok) {
            return res.status(result.status).json({ error: result.error });
        }
        res.status(201).json({
            status: 'registered',
            username: result.username,
            home_region: result.home_region,
            note: 'password stored as bcrypt hash; pepper never persisted (ADR-0049)',
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'internal error';
        res.status(500).json({ error: message });
    }
});

app.post('/auth/login', async (req, res) => {
    try {
        if (!JWT_SECRET) {
            return res.status(500).json({ error: 'JWT_SECRET not configured' });
        }
        const body = req.body || {};
        const username = String(body.username || body.sub || '').trim();
        const password = String(body.password || '');
        const auth = await authenticateUser({
            username,
            password,
            pepper: getPepper(),
        });
        if (!auth.ok) {
            return res.status(auth.status).json({ error: auth.error });
        }
        const ttlSecs = Number.isFinite(body.ttl) ? Math.max(1, Math.min(86400, body.ttl)) : 3600;
        const { token, claims } = mintJwt({
            sub: auth.username,
            homeRegion: auth.home_region,
            ttlSecs,
        });
        res.json({ token, claims });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'internal error';
        res.status(500).json({ error: message });
    }
});

app.post('/auth/dev-token', (req, res) => {
    if (!AUTH_DEV_TOKENS) {
        return res.status(403).json({
            error: 'dev token minting disabled',
            hint: 'AUTH_DEV_TOKENS=0 — point the frontend /auth proxy at a real auth service.',
        });
    }
    if (!JWT_SECRET) {
        return res.status(500).json({ error: 'JWT_SECRET not configured on backend-test-service' });
    }
    const body = req.body || {};
    const sub = String(body.sub || 'test-user');
    const homeRegion = String(body.home_region || 'US');
    const ttlSecs = Number.isFinite(body.ttl) ? Math.max(1, Math.min(86400, body.ttl)) : 3600;
    const { token, claims } = mintJwt({ sub, homeRegion, jti: body.jti, ttlSecs });
    res.json({ token, claims, note: 'dev token — signed with shared JWT_SECRET' });
});

app.all('*', (req, res) => {
    res.json({
        service: 'backend-test-service',
        method: req.method,
        path: req.path,
        identity: identityFrom(req),
    });
});

app.listen(PORT, () => {
    warnInsecurePepper();
    console.log(
        `backend-test-service on :${PORT} (dev-tokens=${AUTH_DEV_TOKENS}, region=${process.env.SERVICE_REGION || 'n/a'}, bcrypt cost=${process.env.BCRYPT_COST || 12})`,
    );
});
