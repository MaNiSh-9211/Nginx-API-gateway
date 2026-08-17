import crypto from 'crypto';
import { config } from '../config';
import { IUser } from '../models/User';
import { UserIdentityIndex } from '../models/UserIdentityIndex';
import { normalizeEmail } from '../utils/email-normalize.util';

export type EmailResolveMatch = 'primary' | 'previous' | 'pending_migration';

export interface ResolvedEmailIdentity {
    userId: string;
    match: EmailResolveMatch;
    verified?: boolean;
}

function indexSecret(): string {
    return process.env.EMAIL_INDEX_SECRET || config.jwt.accessSecret;
}

function emailKey(kind: 'primary_email' | 'previous_email' | 'pending_migration', email: string): string {
    const normalized = normalizeEmail(email);
    const digest = crypto.createHmac('sha256', indexSecret()).update(normalized, 'utf8').digest('hex');
    return `${kind}:${digest}`;
}

function oauthKey(provider: string, providerId: string): string {
    return `oauth:${provider}:${providerId}`;
}

function isActive(doc: { expiresAt?: Date | null }): boolean {
    if (!doc.expiresAt) return true;
    return doc.expiresAt > new Date();
}

export async function ensureIdentityIndexIndexes(): Promise<void> {
    // No-op — indexes are created by DB migrations (001_init). Retained for
    // call-site compatibility with the old Mongo driver error handling.
    return;
}

/** Resolve email to userId via inverted indexes (primary → previous → pending migration). */
export async function resolveEmailIdentity(email: string): Promise<ResolvedEmailIdentity | null> {
    const normalized = normalizeEmail(email);
    const kinds: Array<{ kind: 'primary_email' | 'previous_email' | 'pending_migration'; match: EmailResolveMatch }> = [
        { kind: 'primary_email', match: 'primary' },
        { kind: 'previous_email', match: 'previous' },
        { kind: 'pending_migration', match: 'pending_migration' },
    ];

    for (const { kind, match } of kinds) {
        const doc = await UserIdentityIndex.findOne({ key: emailKey(kind, normalized) }).lean();
        if (!doc || !isActive(doc)) continue;
        return {
            userId: doc.userId,
            match,
            verified: doc.verified,
        };
    }
    return null;
}

export async function findUserIdByPrimaryEmail(email: string): Promise<string | null> {
    const doc = await UserIdentityIndex.findOne({ key: emailKey('primary_email', email) }).lean();
    if (!doc || !isActive(doc)) return null;
    return doc.userId;
}

export async function findPendingMigrationHolder(email: string): Promise<string | null> {
    const doc = await UserIdentityIndex.findOne({
        key: emailKey('pending_migration', email),
        expiresAt: { $gt: new Date() },
    }).lean();
    return doc ? doc.userId : null;
}

export async function findUserIdByOAuth(
    provider: 'google' | 'github',
    providerId: string,
): Promise<string | null> {
    const doc = await UserIdentityIndex.findOne({ key: oauthKey(provider, providerId) }).lean();
    if (!doc) return null;
    return doc.userId;
}

export async function releaseUserIdentityIndexes(userId: string): Promise<void> {
    await UserIdentityIndex.deleteMany({ userId });
}

export async function releasePrimaryEmail(email: string): Promise<void> {
    await UserIdentityIndex.deleteOne({ key: emailKey('primary_email', email) });
}

export async function clearPendingMigration(email: string): Promise<void> {
    await UserIdentityIndex.deleteOne({ key: emailKey('pending_migration', email) });
}

export async function clearPreviousEmail(email: string): Promise<void> {
    await UserIdentityIndex.deleteOne({ key: emailKey('previous_email', email) });
}

function expectedKeysForUser(user: IUser): Set<string> {
    const keys = new Set<string>();
    keys.add(emailKey('primary_email', user.email));

    if (user.previousEmail && user.migrationExpiry && user.migrationExpiry > new Date()) {
        keys.add(emailKey('previous_email', user.previousEmail));
    }
    if (user.newEmailPending && user.migrationTokenExpires && user.migrationTokenExpires > new Date()) {
        keys.add(emailKey('pending_migration', user.newEmailPending));
    }
    if (user.provider !== 'local' && user.providerId) {
        keys.add(oauthKey(user.provider, user.providerId));
    }
    return keys;
}

/** Upsert all identity index entries implied by a User document; prune stale keys for this user. */
export async function syncIdentityIndexesFromUser(user: IUser): Promise<void> {
    const userId = user._id;
    const expected = expectedKeysForUser(user);

    await UserIdentityIndex.updateOne(
        { key: emailKey('primary_email', user.email) },
        {
            $set: {
                kind: 'primary_email',
                userId,
                verified: user.isEmailVerified === true,
            },
            $unset: { expiresAt: '', provider: '' },
        },
        { upsert: true },
    );

    if (user.previousEmail && user.migrationExpiry && user.migrationExpiry > new Date()) {
        await UserIdentityIndex.updateOne(
            { key: emailKey('previous_email', user.previousEmail) },
            {
                $set: {
                    kind: 'previous_email',
                    userId,
                    expiresAt: user.migrationExpiry,
                },
                $unset: { verified: '', provider: '' },
            },
            { upsert: true },
        );
    }

    if (user.newEmailPending && user.migrationTokenExpires && user.migrationTokenExpires > new Date()) {
        await UserIdentityIndex.updateOne(
            { key: emailKey('pending_migration', user.newEmailPending) },
            {
                $set: {
                    kind: 'pending_migration',
                    userId,
                    expiresAt: user.migrationTokenExpires,
                },
                $unset: { verified: '', provider: '' },
            },
            { upsert: true },
        );
    }

    if (user.provider !== 'local' && user.providerId) {
        await UserIdentityIndex.updateOne(
            { key: oauthKey(user.provider, user.providerId) },
            {
                $set: {
                    kind: 'oauth',
                    userId,
                    provider: user.provider,
                },
                $unset: { verified: '', expiresAt: '' },
            },
            { upsert: true },
        );
    }

    await UserIdentityIndex.deleteMany({
        userId,
        key: { $nin: Array.from(expected) },
    });
}

/** Idempotent backfill from existing User rows (safe on every startup). */
export async function backfillIdentityIndexes(): Promise<{ scanned: number; synced: number }> {
    const { User } = await import('../models/User');
    const cursor = User.find({}).cursor();
    let scanned = 0;
    let synced = 0;

    for await (const user of cursor) {
        scanned += 1;
        await syncIdentityIndexesFromUser(user);
        synced += 1;
    }

    return { scanned, synced };
}
