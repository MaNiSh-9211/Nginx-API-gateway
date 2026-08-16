export const rateLimitConfig = {
    // Login Rate Limiting (Exponential Backoff)
    login: {
        windowMs: 60 * 60 * 1000, // Reset window (1 hour) if not blocked
        allowedAttempts: 5,        // First 5 attempts free
        blockDuration: {
            step1: 5 * 60 * 1000,   // 6th attempt: 5 mins
            step2: 25 * 60 * 1000,  // 7th attempt: 25 mins
            step3: 125 * 60 * 1000, // 8th+ attempt: ~2 hours
        },
        maxDailyLogins: 100, // Max successful logins per user per day
    },

    // Password Reset Limiting
    passwordReset: {
        dailyLimit: 10,        // Max total requests per day
        windowMs: 12 * 60 * 60 * 1000, // 12-hour window
        limitPerWindow: 5,     // 5 requests per 12 hours
    },

    // Email Availability Check (Prevent Enumeration)
    emailCheck: {
        windowMs: 60 * 1000,   // 1 Minute
        limit: 10,             // 10 checks per minute
    },

    // Session refresh / logout
    session: {
        windowMs: 60 * 1000,
        limit: 30,
    },
};
