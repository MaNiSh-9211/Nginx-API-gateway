/**
 * Publishes access-token revocation to the gateway control plane (ADR-0038/0039).
 *
 * On logout the auth service must kill the short-lived access JWT in Redis so
 * gateways stop accepting it before `exp`. Refresh-token removal alone is not
 * enough — the gateway never sees refresh tokens.
 */
import { config } from '../config';
import { adminSignHeaders } from '../utils/admin-sign.util';

export interface RevokeOptions {
    jti?: string;
    ttlSecs?: number;
}

/** Decode JWT payload (middle segment) without signature verification — TTL/jti only. */
function decodePayload(token: string): { jti?: string; exp?: number } | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const json = Buffer.from(parts[1], 'base64url').toString('utf8');
        const payload = JSON.parse(json) as { jti?: string; exp?: number };
        return payload;
    } catch {
        return null;
    }
}

function remainingTtlSecs(exp?: number, fallback = 3600): number {
    if (!exp) return fallback;
    const remaining = exp - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return 60;
    return Math.min(Math.max(remaining, 60), 86_400);
}

function signBody(body: string): Record<string, string> {
    return adminSignHeaders(body);
}

/**
 * Best-effort revoke. Returns true when the control plane accepted the request.
 * Never throws — logout must succeed even if Redis/control-plane is down.
 */
export async function revokeAccessToken(
    rawToken: string,
    options: RevokeOptions = {},
): Promise<boolean> {
    const token = rawToken.replace(/^Bearer\s+/i, '').trim();
    if (!token) return false;

    const payload = decodePayload(token);
    const jti = options.jti ?? payload?.jti;
    const ttl_secs = options.ttlSecs ?? remainingTtlSecs(payload?.exp);

    const bodyObj: Record<string, unknown> = { ttl_secs };
    if (jti) bodyObj.jti = jti;
    bodyObj.token = token;

    const body = JSON.stringify(bodyObj);
    const url = `${config.controlPlane.url.replace(/\/$/, '')}/revoke`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: signBody(body),
            body,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.warn(`Gateway revoke rejected (${res.status}): ${text}`);
            return false;
        }
        return true;
    } catch (err) {
        console.warn('Gateway token revocation failed (best-effort):', err);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Revoke by jti only (password reset / session kill when token string unavailable). */
export async function revokeByJti(jti: string, ttlSecs = 900): Promise<boolean> {
    if (!jti) return false;
    const body = JSON.stringify({ jti, ttl_secs: ttlSecs });
    const url = `${config.controlPlane.url.replace(/\/$/, '')}/revoke`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: signBody(body),
            body,
            signal: controller.signal,
        });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}
