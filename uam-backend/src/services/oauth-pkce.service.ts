/**
 * OAuth PKCE + state binding for SPA exchange codes (BFF-style).
 */
import crypto from 'crypto';
import { cacheDel, cacheGet, cacheSet, isRedisAvailable } from '../config/redis';
import { config } from '../config';

const STATE_TTL_SECS = 600;
const STATE_BYTES = 32;

interface StateRecord {
    codeChallenge: string;
}

const memoryStates = new Map<string, { record: StateRecord; exp: number }>();

function pruneMemory(): void {
    const now = Date.now();
    for (const [k, v] of memoryStates) {
        if (v.exp <= now) memoryStates.delete(k);
    }
}

function verifyPkceChallenge(codeVerifier: string, codeChallenge: string): boolean {
    const digest = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return digest === codeChallenge;
}

/** Store PKCE challenge and return opaque state for OAuth redirect. */
export async function createOAuthState(codeChallenge: string): Promise<string> {
    if (!codeChallenge || codeChallenge.length < 43 || codeChallenge.length > 128) {
        throw new Error('Invalid code challenge');
    }

    const state = crypto.randomBytes(STATE_BYTES).toString('hex');
    const record: StateRecord = { codeChallenge };

    if (isRedisAvailable()) {
        await cacheSet(`uam:oauth-state:${state}`, JSON.stringify(record), STATE_TTL_SECS);
        return state;
    }

    if (config.nodeEnv === 'production') {
        throw new Error('Redis required for OAuth state in production');
    }

    pruneMemory();
    memoryStates.set(state, { record, exp: Date.now() + STATE_TTL_SECS * 1000 });
    return state;
}

/** Validate PKCE verifier against stored state (one-time). */
export async function consumeOAuthState(
    state: string,
    codeVerifier: string,
): Promise<boolean> {
    if (!state || !codeVerifier) return false;

    let record: StateRecord | null = null;

    if (isRedisAvailable()) {
        const raw = await cacheGet(`uam:oauth-state:${state}`);
        if (!raw) return false;
        await cacheDel(`uam:oauth-state:${state}`);
        try {
            record = JSON.parse(raw) as StateRecord;
        } catch {
            return false;
        }
    } else {
        const entry = memoryStates.get(state);
        memoryStates.delete(state);
        if (!entry || entry.exp < Date.now()) return false;
        record = entry.record;
    }

    if (!record) return false;
    return verifyPkceChallenge(codeVerifier, record.codeChallenge);
}
