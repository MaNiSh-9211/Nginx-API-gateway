import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { CSRF_COOKIE, cookieBase } from '../utils/cookie.util';

const CSRF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Issue readable CSRF cookie when missing (double-submit pattern). */
export function issueCsrfCookie(req: Request, res: Response): string {
    const existing = req.cookies?.[CSRF_COOKIE] as string | undefined;
    if (existing) return existing;

    const csrf = crypto.randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, csrf, {
        ...cookieBase(),
        httpOnly: false,
        maxAge: CSRF_MAX_AGE_MS,
    });
    return csrf;
}

/** GET /api/auth/csrf — bootstrap CSRF before any state-changing auth POST. */
export function getCsrfToken(req: Request, res: Response): void {
    const csrf = issueCsrfCookie(req, res);
    res.json({ success: true, csrfToken: csrf });
}

/** Require X-CSRF-Token header matching uam_csrf cookie (cookie-auth mode). */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
    if (!config.auth.omitRefreshInBody) {
        next();
        return;
    }

    const csrfCookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
    const csrfHeader = req.headers['x-csrf-token'];
    const headerVal = typeof csrfHeader === 'string' ? csrfHeader : '';

    if (!csrfCookie || !headerVal || csrfCookie !== headerVal) {
        res.status(403).json({ success: false, message: 'CSRF validation failed' });
        return;
    }

    next();
}

/** @deprecated Use requireCsrf — kept for backward compatibility during rollout. */
export const requireCsrfForCookieAuth = requireCsrf;
