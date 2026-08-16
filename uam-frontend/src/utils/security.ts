export function validatePassword(password: string): string | null {
    if (!password) return 'Password is required';
    if (password.length < 8) return 'Password must be at least 8 characters';
    if (password.length > 128) return 'Password is too long';
    if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
    if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
    if (!/[0-9]/.test(password)) return 'Password must contain a number';
    if (!/[^A-Za-z0-9]/.test(password)) return 'Password must contain a special character';
    return null;
}

const ALLOWED_AVATAR_HOSTS = new Set([
    'lh3.googleusercontent.com',
    'avatars.githubusercontent.com',
    'secure.gravatar.com',
    'www.gravatar.com',
    'gravatar.com',
]);

export function isSafeAvatarUrl(url: string | undefined): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        return ALLOWED_AVATAR_HOSTS.has(parsed.hostname);
    } catch {
        return false;
    }
}

export function sanitizeAvatarUrl(url: string | undefined): string | undefined {
    return isSafeAvatarUrl(url) ? url : undefined;
}
