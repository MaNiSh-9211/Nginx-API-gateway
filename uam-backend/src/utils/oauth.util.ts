import { IUser } from '../models/User';

/** Reject OAuth login when email belongs to a different auth method (ADR-0054). */
export function oauthProviderConflict(
    user: IUser,
    incoming: 'google' | 'github',
): string | null {
    if (user.provider === 'local') {
        return 'This email uses password login. Sign in with your password first.';
    }
    if (user.provider !== incoming) {
        return `This email is registered with ${user.provider}. Use that provider to sign in.`;
    }
    return null;
}
