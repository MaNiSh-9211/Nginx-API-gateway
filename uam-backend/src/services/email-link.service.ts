/**
 * Opaque email link codes — raw tokens never appear in URLs or email hrefs.
 *
 * Flow: email contains ?code=opaque → SPA POST /redeem-email-link → short-lived
 * formToken → SPA POST verify/reset/migrate with formToken only.
 */
import crypto from 'crypto';
import { cacheDel, cacheGet, cacheSet, isRedisAvailable } from '../config/redis';
import { config } from '../config';

const LINK_TTL_SECS = 86_400; // 24h — matches verification window
const FORM_TTL_SECS = 600; // 10 min to complete the form
const CODE_BYTES = 32;

export type EmailLinkKind =
    | 'verify-email'
    | 'reset-password'
    | 'migrate-current'
    | 'migrate-new';

interface LinkPayload {
    kind: EmailLinkKind;
    secret: string;
    meta?: Record<string, string>;
}

interface FormPayload {
    kind: EmailLinkKind;
    secret: string;
    meta?: Record<string, string>;
}

const memoryLinks = new Map<string, { payload: LinkPayload; exp: number }>();
const memoryForms = new Map<string, { payload: FormPayload; exp: number }>();

function pruneMemory(store: Map<string, { exp: number }>): void {
    const now = Date.now();
    for (const [k, v] of store) {
        if (v.exp <= now) store.delete(k);
    }
}

/** Create opaque code for email href (never embed the raw secret token). */
export async function createEmailLinkCode(
    kind: EmailLinkKind,
    secret: string,
    meta?: Record<string, string>,
): Promise<string> {
    const code = crypto.randomBytes(CODE_BYTES).toString('hex');
    const payload: LinkPayload = { kind, secret, meta };

    if (isRedisAvailable()) {
        await cacheSet(`uam:email-link:${code}`, JSON.stringify(payload), LINK_TTL_SECS);
        return code;
    }

    if (config.nodeEnv === 'production') {
        throw new Error('Redis required for email link codes in production');
    }

    pruneMemory(memoryLinks);
    memoryLinks.set(code, { payload, exp: Date.now() + LINK_TTL_SECS * 1000 });
    return code;
}

/** Redeem email link code (POST-only) → short-lived form token. */
export async function redeemEmailLinkCode(
    code: string,
): Promise<{ kind: EmailLinkKind; formToken: string; meta?: Record<string, string> } | null> {
    if (!code || code.length < CODE_BYTES * 2) return null;

    let payload: LinkPayload | null = null;

    if (isRedisAvailable()) {
        const raw = await cacheGet(`uam:email-link:${code}`);
        if (!raw) return null;
        await cacheDel(`uam:email-link:${code}`);
        try {
            payload = JSON.parse(raw) as LinkPayload;
        } catch {
            return null;
        }
    } else {
        const entry = memoryLinks.get(code);
        memoryLinks.delete(code);
        if (!entry || entry.exp < Date.now()) return null;
        payload = entry.payload;
    }

    if (!payload) return null;

    const formToken = crypto.randomBytes(CODE_BYTES).toString('hex');
    const formPayload: FormPayload = {
        kind: payload.kind,
        secret: payload.secret,
        meta: payload.meta,
    };

    if (isRedisAvailable()) {
        await cacheSet(`uam:email-form:${formToken}`, JSON.stringify(formPayload), FORM_TTL_SECS);
    } else {
        pruneMemory(memoryForms);
        memoryForms.set(formToken, {
            payload: formPayload,
            exp: Date.now() + FORM_TTL_SECS * 1000,
        });
    }

    return { kind: payload.kind, formToken, meta: payload.meta };
}

/** Consume form token for the final POST action. */
export async function consumeFormToken(
    formToken: string,
    expectedKind: EmailLinkKind,
): Promise<{ secret: string; meta?: Record<string, string> } | null> {
    if (!formToken || formToken.length < CODE_BYTES * 2) return null;

    let payload: FormPayload | null = null;

    if (isRedisAvailable()) {
        const raw = await cacheGet(`uam:email-form:${formToken}`);
        if (!raw) return null;
        await cacheDel(`uam:email-form:${formToken}`);
        try {
            payload = JSON.parse(raw) as FormPayload;
        } catch {
            return null;
        }
    } else {
        const entry = memoryForms.get(formToken);
        memoryForms.delete(formToken);
        if (!entry || entry.exp < Date.now()) return null;
        payload = entry.payload;
    }

    if (!payload || payload.kind !== expectedKind) return null;
    return { secret: payload.secret, meta: payload.meta };
}
