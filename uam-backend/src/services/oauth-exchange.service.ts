/**
 * One-time OAuth exchange codes — bound to OAuth state (PKCE flow).
 */
import crypto from 'crypto';
import { cacheDel, cacheGet, cacheSet, isRedisAvailable } from '../config/redis';
import { config } from '../config';

const CODE_TTL_SECS = 120;
const CODE_BYTES = 32;

interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

interface ExchangeRecord {
    tokens: TokenPair;
    state: string;
}

const memoryCodes = new Map<string, { record: ExchangeRecord; exp: number }>();

function pruneMemoryCodes(): void {
    const now = Date.now();
    for (const [k, v] of memoryCodes) {
        if (v.exp <= now) memoryCodes.delete(k);
    }
}

export async function createOAuthExchangeCode(
    accessToken: string,
    refreshToken: string,
    state: string,
): Promise<string> {
    if (!state) {
        throw new Error('OAuth state is required for exchange codes');
    }

    const code = crypto.randomBytes(CODE_BYTES).toString('hex');
    const record: ExchangeRecord = {
        tokens: { accessToken, refreshToken },
        state,
    };

    if (isRedisAvailable()) {
        await cacheSet(`uam:oauth:${code}`, JSON.stringify(record), CODE_TTL_SECS);
        return code;
    }

    if (config.nodeEnv === 'production') {
        throw new Error('Redis required for OAuth exchange codes in production');
    }

    pruneMemoryCodes();
    memoryCodes.set(code, {
        record,
        exp: Date.now() + CODE_TTL_SECS * 1000,
    });
    return code;
}

export async function consumeOAuthExchangeCode(
    code: string,
    state: string,
): Promise<TokenPair | null> {
    if (!code || code.length < CODE_BYTES * 2 || !state) return null;

    let record: ExchangeRecord | null = null;

    if (isRedisAvailable()) {
        const key = `uam:oauth:${code}`;
        const raw = await cacheGet(key);
        if (!raw) return null;
        await cacheDel(key);
        try {
            record = JSON.parse(raw) as ExchangeRecord;
        } catch {
            return null;
        }
    } else {
        const entry = memoryCodes.get(code);
        memoryCodes.delete(code);
        if (!entry || entry.exp < Date.now()) return null;
        record = entry.record;
    }

    if (!record || record.state !== state) return null;
    return record.tokens;
}
