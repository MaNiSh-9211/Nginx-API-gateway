import { Router, Request, Response, NextFunction } from 'express';
import passport from '../config/passport';
import { validate } from '../middleware/validate.middleware';
import { authenticate, requireVerifiedEmail } from '../middleware/auth.middleware';
import {
    registerSchema,
    loginSchema,
    emailCheckSchema,
    emailVerifySchema,
    passwordResetRequestSchema,
    passwordResetSchema,
    refreshTokenSchema,
    oauthExchangeSchema,
    oauthPrepareSchema,
    redeemEmailLinkSchema,
    verificationPollSchema,
    resendVerificationSchema,
} from '../validators/auth.validators';
import {
    register,
    login,
    checkEmailAvailability,
    verifyEmail,
    resendVerification,
    requestPasswordReset,
    resetPassword,
    refreshAccessToken,
    logout,
    getCurrentUser,
    handleOAuthSuccess,
    exchangeOAuthCode,
    prepareOAuth,
    getOAuthProviders,
    redeemEmailLink,
    getVerificationStatus,
    postVerificationStatus,
} from '../controllers/auth.controller';

import { authLimiter, emailCheckLimiter, passwordResetLimiter, sessionLimiter } from '../middleware/limiter.middleware';
import { advancedLoginLimiter } from '../middleware/advancedLimiter';
import { requireCsrf, getCsrfToken } from '../middleware/csrf.middleware';
import { config } from '../config';

const router = Router();

const oauthFailureRedirect = `${config.clientUrl}/login?error=oauth_failed`;
const oauthNotConfiguredRedirect = `${config.clientUrl}/login?error=oauth_not_configured`;

const csrfProtected = [requireCsrf];

function requireOAuthProvider(provider: 'google' | 'github') {
    return (req: Request, res: Response, next: NextFunction) => {
        const enabled = provider === 'google' ? config.oauth.googleEnabled : config.oauth.githubEnabled;
        if (!enabled) {
            if (req.method === 'GET') {
                res.redirect(oauthNotConfiguredRedirect);
                return;
            }
            res.status(503).json({
                success: false,
                code: 'OAUTH_NOT_CONFIGURED',
                message: `${provider} sign-in is not configured on this server`,
            });
            return;
        }
        next();
    };
}

router.get('/csrf', getCsrfToken);
router.get('/oauth/providers', getOAuthProviders);

router.post('/check-email', emailCheckLimiter, validate(emailCheckSchema), checkEmailAvailability);
router.get('/verification-status', emailCheckLimiter, getVerificationStatus);
router.post('/verification-status', emailCheckLimiter, validate(verificationPollSchema), postVerificationStatus);

router.post('/redeem-email-link', authLimiter, validate(redeemEmailLinkSchema), redeemEmailLink);
router.post('/oauth/prepare', authLimiter, validate(oauthPrepareSchema), prepareOAuth);

router.post('/register', authLimiter, ...csrfProtected, validate(registerSchema), register);
router.post('/login', advancedLoginLimiter, ...csrfProtected, validate(loginSchema), login);
router.post('/verify-email', authLimiter, ...csrfProtected, validate(emailVerifySchema), verifyEmail);
router.post('/resend-verification', authLimiter, ...csrfProtected, validate(resendVerificationSchema), resendVerification);

router.post('/forgot-password', passwordResetLimiter, ...csrfProtected, validate(passwordResetRequestSchema), requestPasswordReset);
router.post('/reset-password', passwordResetLimiter, ...csrfProtected, validate(passwordResetSchema), resetPassword);
router.post('/refresh-token', sessionLimiter, ...csrfProtected, validate(refreshTokenSchema), refreshAccessToken);
router.post('/logout', sessionLimiter, ...csrfProtected, logout);
router.post('/oauth/exchange', authLimiter, ...csrfProtected, validate(oauthExchangeSchema), exchangeOAuthCode);

router.get('/me', authenticate, requireVerifiedEmail, getCurrentUser);

router.get(
    '/google',
    requireOAuthProvider('google'),
    (req, res, next) => {
        const { login_hint, prompt, state } = req.query;

        const options: Record<string, unknown> = {
            scope: ['profile', 'email'],
            session: false,
        };

        if (login_hint) {
            options.loginHint = login_hint as string;
        }

        if (prompt === 'select_account' || (!login_hint && !prompt)) {
            options.prompt = 'select_account';
        }

        if (state && typeof state === 'string') {
            options.state = state;
        }

        passport.authenticate('google', options)(req, res, next);
    },
);

router.get(
    '/google/callback',
    requireOAuthProvider('google'),
    passport.authenticate('google', { session: false, failureRedirect: oauthFailureRedirect }),
    handleOAuthSuccess,
);

router.get(
    '/github',
    requireOAuthProvider('github'),
    (req, res, next) => {
        const { state } = req.query;
        const options: Record<string, unknown> = {
            scope: ['user:email'],
            session: false,
        };
        if (state && typeof state === 'string') {
            options.state = state;
        }
        passport.authenticate('github', options)(req, res, next);
    },
);

router.get(
    '/github/callback',
    requireOAuthProvider('github'),
    passport.authenticate('github', { session: false, failureRedirect: oauthFailureRedirect }),
    handleOAuthSuccess,
);

export default router;
