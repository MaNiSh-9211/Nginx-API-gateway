# ADR-0061: Email service logging hygiene

## Status

Accepted

## Context

`services/uam/backend/src/services/email.service.ts` (from auth-advance) logged at startup:

- SMTP username
- Password **length** (aids offline cracking estimates)
- Full email HTML in mock mode including password-reset and verification **tokens in URLs**

Nodemailer was configured with `debug: true` and `logger: true` unconditionally,
which can emit SMTP protocol details in production container logs.

In Docker UAM stacks, `NODE_ENV=production` but SMTP is often unset — mock logging
still ran only in `development`, so production attempted real sends with empty auth.

## Decision

1. Never log SMTP credentials, password length, or full message bodies in
   production.
2. Enable nodemailer `debug` / `logger` only when `NODE_ENV=development` **and**
   SMTP is configured.
3. When SMTP is not configured, skip send:
   - **Dev:** log recipient + subject only (no HTML / tokens).
   - **Production:** log a one-line warning without message content.
4. Remove OAuth callback URL console logging from passport strategy.

## Consequences

- Operators must configure `SMTP_*` for real email in production.
- Dev mock mode no longer prints clickable reset/verify links in logs — use
  `AUTO_VERIFY_EMAIL` or configure SMTP for local email flows.
