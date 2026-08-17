/**
 * Field <-> column mapping for the users table.
 *
 * The application uses camelCase field names (mirroring the old Mongoose
 * document), while Postgres columns are snake_case. This module is the single
 * source of truth used by the query/filter compiler and the row mapper.
 */

export const FIELD_TO_COLUMN: Record<string, string> = {
    id: 'id',
    email: 'email',
    previousEmail: 'previous_email',
    password: 'password',
    displayName: 'display_name',
    avatar: 'avatar',
    bio: 'bio',
    isEmailVerified: 'is_email_verified',
    loginCount: 'login_count',
    lastLogin: 'last_login',
    emailVerificationToken: 'email_verification_token',
    emailVerificationExpires: 'email_verification_expires',
    passwordResetToken: 'password_reset_token',
    passwordResetExpires: 'password_reset_expires',
    provider: 'provider',
    providerId: 'provider_id',
    refreshTokens: 'refresh_tokens',
    activeAccessJtis: 'active_access_jtis',
    tokenVersion: 'token_version',
    migrationExpiry: 'migration_expiry',
    migrationToken: 'migration_token',
    migrationTokenExpires: 'migration_token_expires',
    newEmailPending: 'new_email_pending',
    lastMigrationDate: 'last_migration_date',
    currentEmailVerified: 'current_email_verified',
    newEmailVerified: 'new_email_verified',
    currentEmailToken: 'current_email_token',
    newEmailToken: 'new_email_token',
    lastMigrationEmailSent: 'last_migration_email_sent',
    migrationHistory: 'migration_history',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
};

export const COLUMN_TO_FIELD: Record<string, string> = Object.fromEntries(
    Object.entries(FIELD_TO_COLUMN).map(([k, v]) => [v, k]),
);

/** Every writable field (excludes generated timestamps handled by DB). */
export const ALL_FIELDS: string[] = Object.keys(FIELD_TO_COLUMN);

/** Fields never returned by default — must be requested with `.select('+field')`. */
export const SENSITIVE_FIELDS = new Set<string>(['password', 'refreshTokens', 'activeAccessJtis']);

/** JSONB array fields — read/written as a whole document-style array. */
export const JSONB_FIELDS = new Set<string>(['refreshTokens', 'activeAccessJtis', 'migrationHistory']);

export function columnName(field: string): string {
    if (field === '_id') return 'id';
    const col = FIELD_TO_COLUMN[field];
    if (!col) {
        throw new Error(`Unknown field: ${field}`);
    }
    return col;
}

export function fieldName(column: string): string {
    const field = COLUMN_TO_FIELD[column];
    if (!field) {
        throw new Error(`Unknown column: ${column}`);
    }
    return field;
}