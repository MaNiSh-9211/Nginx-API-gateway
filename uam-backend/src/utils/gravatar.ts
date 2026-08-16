import crypto from 'crypto';

/**
 * Generate Gravatar URL from email address
 * @param email - User's email address
 * @param size - Image size in pixels (default: 200)
 * @returns Gravatar URL
 */
export function getGravatarUrl(email: string, size: number = 200): string {
    if (!email) return '';
    
    const normalizedEmail = email.trim().toLowerCase();
    const hash = crypto.createHash('md5').update(normalizedEmail).digest('hex');
    
    return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon&r=pg`;
}

/**
 * Get avatar URL - prefers OAuth avatar, falls back to Gravatar
 * @param email - User's email address
 * @param oauthAvatar - Avatar from OAuth provider (if available)
 * @param size - Image size in pixels (default: 200)
 * @returns Avatar URL
 */
export function getAvatarUrl(email: string, oauthAvatar?: string, size: number = 200): string {
    // If OAuth avatar exists, use it
    if (oauthAvatar) {
        return oauthAvatar;
    }
    
    // Otherwise, use Gravatar
    return getGravatarUrl(email, size);
}

