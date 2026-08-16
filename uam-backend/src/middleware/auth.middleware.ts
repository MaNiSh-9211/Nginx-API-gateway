import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/token.service';
import { User } from '../models/User';

function tokenVersionStale(payloadTv: number | undefined, userTv: number | undefined): boolean {
    const expected = userTv ?? 0;
    const actual = payloadTv ?? 0;
    return actual !== expected;
}


export const authenticate = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({
                success: false,
                message: 'Access token is required',
            });
            return;
        }

        const token = authHeader.split(' ')[1];
        const payload = verifyAccessToken(token);

        if (!payload) {
            res.status(401).json({
                success: false,
                message: 'Invalid or expired access token',
            });
            return;
        }

        const user = await User.findById(payload.userId);

        if (!user) {
            res.status(401).json({
                success: false,
                message: 'User not found',
            });
            return;
        }

        if (tokenVersionStale(payload.tv, user.tokenVersion)) {
            res.status(401).json({
                success: false,
                message: 'Session expired — please sign in again',
            });
            return;
        }

        (req as any).user = user;
        next();
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Authentication error',
        });
    }
};

export const optionalAuth = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const payload = verifyAccessToken(token);

            if (payload) {
                const user = await User.findById(payload.userId);
                if (user && !tokenVersionStale(payload.tv, user.tokenVersion)) {
                    (req as any).user = user;
                }
            }
        }

        next();
    } catch {
        next();
    }
};

/** Reject authenticated users who have not completed email verification. */
export const requireVerifiedEmail = (
    req: Request,
    res: Response,
    next: NextFunction,
): void => {
    const user = (req as any).user as { isEmailVerified?: boolean } | undefined;
    if (!user?.isEmailVerified) {
        res.status(403).json({
            success: false,
            message: 'Email verification required',
            code: 'EMAIL_NOT_VERIFIED',
        });
        return;
    }
    next();
};
