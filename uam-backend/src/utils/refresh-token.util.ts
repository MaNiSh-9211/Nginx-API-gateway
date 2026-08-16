import crypto from 'crypto';

/** SHA-256 hash of refresh JWT for at-rest storage (never store raw tokens in MongoDB). */
export function hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/** Match presented token against stored hashes (supports legacy plaintext entries during rollout). */
export function findStoredRefreshToken(stored: string[] | undefined, presented: string): string | null {
    if (!stored?.length) return null;
    const hashed = hashRefreshToken(presented);
    if (stored.includes(hashed)) return hashed;
    if (stored.includes(presented)) return presented;
    return null;
}
