/**
 * Track issued access-token JTIs and persist refresh tokens for session lifecycle.
 */
import mongoose from 'mongoose';
import { User } from '../models/User';
import { cacheSet, cacheGet, isRedisAvailable } from '../config/redis';
import { revokeByJti } from './revoke.service';
import {
    findStoredRefreshToken,
    hashRefreshToken,
} from '../utils/refresh-token.util';

const TV_REDIS_PREFIX = 'gateway:user:tv:';

const MAX_REFRESH = 5;
const MAX_JTIS = 20;
/** Match JWT_ACCESS_EXPIRES_IN default (15m) for revocation TTL when token absent. */
const ACCESS_REVOKE_TTL_SECS = 900;

export function extractAccessJti(accessToken: string): string | undefined {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return undefined;
    try {
        const payload = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8'),
        ) as { jti?: string };
        return payload.jti;
    } catch {
        return undefined;
    }
}

/** Publish the user's current token version so the gateway can reject stale JWTs. */
export async function publishTokenVersion(
    userId: mongoose.Types.ObjectId | string,
    version: number,
): Promise<boolean> {
    if (!isRedisAvailable()) {
        return false;
    }
    const key = `${TV_REDIS_PREFIX}${userId.toString()}`;
    await cacheSet(key, String(version));
    const stored = await cacheGet(key);
    return stored === String(version);
}

/** Invalidate every session — used on refresh-token reuse detection and account compromise. */
export async function invalidateAllSessions(
    userId: mongoose.Types.ObjectId | string,
): Promise<void> {
    const user = await User.findById(userId).select('+refreshTokens +activeAccessJtis');
    if (!user) return;

    await revokeAllTrackedAccessJtis(user.activeAccessJtis);
    const newVersion = (user.tokenVersion ?? 0) + 1;
    user.refreshTokens = [];
    user.activeAccessJtis = [];
    user.tokenVersion = newVersion;
    await user.save();
    await publishTokenVersion(userId, newVersion);
}

/** Atomically rotate refresh token + track access JTI (refresh flow). */
export async function rotateSessionTokens(
    userId: mongoose.Types.ObjectId | string,
    oldRefreshToken: string,
    accessToken: string,
    refreshToken: string,
    tokenVersion?: number,
): Promise<boolean> {
    const storedKey = findStoredRefreshToken(
        (await User.findById(userId).select('+refreshTokens'))?.refreshTokens,
        oldRefreshToken,
    );
    if (!storedKey) {
        return false;
    }

    const pulled = await User.findOneAndUpdate(
        { _id: userId, refreshTokens: storedKey },
        { $pull: { refreshTokens: storedKey } },
    );
    if (!pulled) {
        return false;
    }

    try {
        await persistSessionTokens(userId, accessToken, refreshToken, tokenVersion);
        return true;
    } catch {
        await User.findByIdAndUpdate(userId, {
            $push: { refreshTokens: { $each: [storedKey], $slice: -MAX_REFRESH } },
        });
        return false;
    }
}

export async function persistSessionTokens(
    userId: mongoose.Types.ObjectId | string,
    accessToken: string,
    refreshToken: string,
    tokenVersion?: number,
): Promise<void> {
    const jti = extractAccessJti(accessToken);
    const refreshHash = hashRefreshToken(refreshToken);
    const update: Record<string, unknown> = {
        $push: {
            refreshTokens: { $each: [refreshHash], $slice: -MAX_REFRESH },
        },
    };
    if (jti) {
        (update.$push as Record<string, unknown>).activeAccessJtis = {
            $each: [jti],
            $slice: -MAX_JTIS,
        };
    }
    await User.findByIdAndUpdate(userId, update);
    if (tokenVersion !== undefined) {
        await publishTokenVersion(userId, tokenVersion);
    }
}

/** Remove a single refresh token (logout). */
export async function removeRefreshToken(
    userId: mongoose.Types.ObjectId | string,
    refreshToken: string,
): Promise<void> {
    const user = await User.findById(userId).select('+refreshTokens');
    if (!user?.refreshTokens?.length) return;

    const storedKey = findStoredRefreshToken(user.refreshTokens, refreshToken);
    if (!storedKey) return;

    user.refreshTokens = user.refreshTokens.filter((t) => t !== storedKey);
    await user.save();
}

/** Revoke every tracked access JTI (e.g. password reset). Best-effort. */
export async function revokeAllTrackedAccessJtis(
    jtis: string[] | undefined,
): Promise<void> {
    if (!jtis?.length) return;
    await Promise.all(jtis.map((jti) => revokeByJti(jti, ACCESS_REVOKE_TTL_SECS)));
}
