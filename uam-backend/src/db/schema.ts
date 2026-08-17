import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL schema for the UAM backend (migrated from MongoDB+Mongoose).
 *
 * Design (see README / migration notes):
 * - `users`          — one row per account. Previously-embedded arrays
 *                      (`refreshTokens`, `activeAccessJtis`, `migrationHistory`)
 *                      are JSONB: they are always read/written as a whole by
 *                      userId, never queried into, so JSONB is the correct shape
 *                      and keeps the document-style data model.
 * - `user_identity_indexes` — inverted email/OAuth lookup keys (HMAC email
 *                      digests, oauth:<provider>:<id>). `key` is the natural PK;
 *                      MongoDB's TTL on `expiresAt` is replaced by a periodic
 *                      sweeper (Postgres has no TTL).
 *
 * `provider`/`kind`/`status` enums are enforced with CHECK constraints; the
 * Mongo partial-unique `{provider, providerId}` index maps to a plain
 * `UNIQUE(provider, provider_id)` because Postgres treats NULLs as distinct
 * (local accounts never set provider_id).
 */

export const users = pgTable('users', {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    previousEmail: text('previous_email'),
    password: text('password'),
    displayName: text('display_name').notNull(),
    avatar: text('avatar'),
    bio: text('bio'),
    isEmailVerified: boolean('is_email_verified').notNull().default(false),
    loginCount: integer('login_count').notNull().default(0),
    lastLogin: timestamp('last_login', { withTimezone: true }),
    emailVerificationToken: text('email_verification_token'),
    emailVerificationExpires: timestamp('email_verification_expires', { withTimezone: true }),
    passwordResetToken: text('password_reset_token'),
    passwordResetExpires: timestamp('password_reset_expires', { withTimezone: true }),
    provider: text('provider').notNull().default('local'),
    providerId: text('provider_id'),
    refreshTokens: jsonb('refresh_tokens').notNull().default([]),
    activeAccessJtis: jsonb('active_access_jtis').notNull().default([]),
    tokenVersion: integer('token_version').notNull().default(0),
    migrationExpiry: timestamp('migration_expiry', { withTimezone: true }),
    migrationToken: text('migration_token'),
    migrationTokenExpires: timestamp('migration_token_expires', { withTimezone: true }),
    newEmailPending: text('new_email_pending'),
    lastMigrationDate: timestamp('last_migration_date', { withTimezone: true }),
    currentEmailVerified: boolean('current_email_verified'),
    newEmailVerified: boolean('new_email_verified'),
    currentEmailToken: text('current_email_token'),
    newEmailToken: text('new_email_token'),
    lastMigrationEmailSent: timestamp('last_migration_email_sent', { withTimezone: true }),
    migrationHistory: jsonb('migration_history').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    unique('users_email_key').on(table.email),
    unique('users_provider_provider_id_key').on(table.provider, table.providerId),
]);

export const userIdentityIndexes = pgTable('user_identity_indexes', {
    key: text('key').primaryKey(),
    kind: text('kind').notNull(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider'),
    verified: boolean('verified'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    { userIdKindIdx: { name: 'idx_uii_user_id_kind', columns: [table.userId, table.kind] } },
    { expiresAtIdx: { name: 'idx_uii_expires_at', columns: [table.expiresAt] } },
]);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
export type UserIdentityIndexRow = typeof userIdentityIndexes.$inferSelect;
export type UserIdentityIndexInsert = typeof userIdentityIndexes.$inferInsert;