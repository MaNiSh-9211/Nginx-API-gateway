import crypto from 'crypto';
import { Response, Request } from 'express';
import { config } from '../config';

export const REFRESH_COOKIE = 'uam_refresh';
export const CSRF_COOKIE = 'uam_csrf';

/** JSON token fields — refresh omitted in production browser mode (ADR-0055). */
export function publicTokenFields(
    accessToken: string,
    refreshToken: string,
): { accessToken: string; refreshToken?: string } {
    if (config.auth.omitRefreshInBody) {
        return { accessToken };
    }
    return { accessToken, refreshToken };
}

const parseExpiryMs = (expiry: string): number => {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 3600 * 1000;
        case 'd': return value * 86400 * 1000;
        default: return 7 * 24 * 60 * 60 * 1000;
    }
};

export const cookieBase = () => ({
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
    path: config.cookies.path,
});

/** Set HttpOnly refresh + readable CSRF double-submit cookie (ADR-0055). */
export function setAuthCookies(res: Response, refreshToken: string): string {
    const csrf = crypto.randomBytes(32).toString('hex');
    const maxAge = parseExpiryMs(config.jwt.refreshExpiresIn);

    res.cookie(REFRESH_COOKIE, refreshToken, {
        ...cookieBase(),
        httpOnly: true,
        maxAge,
    });
    res.cookie(CSRF_COOKIE, csrf, {
        ...cookieBase(),
        httpOnly: false,
        maxAge,
    });
    return csrf;
}

export function clearAuthCookies(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, cookieBase());
    res.clearCookie(CSRF_COOKIE, cookieBase());
}

export function getRefreshFromRequest(req: Request): string | undefined {
    const fromCookie = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (fromCookie) return fromCookie;
    // Reject body refresh when HttpOnly cookie mode is enforced (ADR-0055 / ADR-0063).
    if (config.auth.omitRefreshInBody) return undefined;
    const body = req.body?.refreshToken;
    return typeof body === 'string' && body.length > 0 ? body : undefined;
}

export function refreshUsesCookie(req: Request): boolean {
    return Boolean(req.cookies?.[REFRESH_COOKIE]);
}
