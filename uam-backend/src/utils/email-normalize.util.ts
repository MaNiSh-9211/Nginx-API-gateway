/** Canonical email form for identity indexes and lookups. */
export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
}
