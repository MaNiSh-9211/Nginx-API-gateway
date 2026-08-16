import nodemailer from 'nodemailer';
import { config } from '../config';
import { createEmailLinkCode } from './email-link.service';

const isDev = config.nodeEnv === 'development';
const smtpConfigured = Boolean(config.smtp.user && config.smtp.pass);

if (isDev) {
    console.log(`[email] SMTP ${smtpConfigured ? 'configured' : 'not configured — mock mode'}`);
}

const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: smtpConfigured
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    debug: isDev && smtpConfigured,
    logger: isDev && smtpConfigured,
});

interface EmailOptions {
    to: string;
    subject: string;
    html: string;
}

const retryWithBackoff = async <T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000,
): Promise<T> => {
    let lastError: Error | unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt === maxRetries) {
                console.error(`[email] send failed after ${maxRetries} attempts`);
                throw error;
            }
            const backoffDelay = delay * Math.pow(2, attempt - 1);
            console.warn(`[email] attempt ${attempt} failed, retry in ${backoffDelay}ms`);
            await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
    }

    throw lastError;
};

export const sendEmail = async (options: EmailOptions, retries: number = 3): Promise<void> => {
    if (!smtpConfigured) {
        if (isDev) {
            console.log(`[email] MOCK to=${options.to} subject="${options.subject}"`);
        } else {
            console.warn(`[email] SMTP not configured — skipped send to ${options.to}`);
        }
        return;
    }

    await retryWithBackoff(async () => {
        try {
            const result = await transporter.sendMail({
                from: `"UAM" <${config.smtp.user}>`,
                to: options.to,
                subject: options.subject,
                html: options.html,
            });
            console.log(`[email] sent to ${options.to} id=${result.messageId}`);
        } catch (error: unknown) {
            const err = error as { code?: string; message?: string };
            console.error(`[email] send error to ${options.to}: ${err.code ?? err.message ?? 'unknown'}`);
            throw error;
        }
    }, retries);
};

export const sendVerificationEmail = async (email: string, token: string): Promise<void> => {
    const linkCode = await createEmailLinkCode('verify-email', token);
    const verificationUrl = `${config.clientUrl}/verify-email?code=${linkCode}`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f4f7; margin: 0; padding: 40px 20px; }
        .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 28px; }
        .content { padding: 40px; }
        .content p { color: #51545e; font-size: 16px; line-height: 1.6; margin: 0 0 20px; }
        .button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; }
        .footer { padding: 20px 40px; background: #f4f4f7; text-align: center; }
        .footer p { color: #9a9ea6; font-size: 14px; margin: 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Verify Your Email</h1>
        </div>
        <div class="content">
          <p>Welcome! Please click the button below to verify your email address and activate your account.</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" class="button">Verify Email Address</a>
          </p>
          <p>If you didn't create an account, you can safely ignore this email.</p>
          <p>This link will expire in 24 hours.</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} UAM. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

    await sendEmail({
        to: email,
        subject: 'Verify Your Email Address',
        html,
    });
};

export const sendPasswordResetEmail = async (email: string, token: string): Promise<void> => {
    const linkCode = await createEmailLinkCode('reset-password', token);
    const resetUrl = `${config.clientUrl}/reset-password?code=${linkCode}`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f4f4f7; margin: 0; padding: 40px 20px; }
        .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow: hidden; }
        .header { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); padding: 40px 20px; text-align: center; }
        .header h1 { color: #ffffff; margin: 0; font-size: 28px; }
        .content { padding: 40px; }
        .content p { color: #51545e; font-size: 16px; line-height: 1.6; margin: 0 0 20px; }
        .button { display: inline-block; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; }
        .footer { padding: 20px 40px; background: #f4f4f7; text-align: center; }
        .footer p { color: #9a9ea6; font-size: 14px; margin: 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Reset Your Password</h1>
        </div>
        <div class="content">
          <p>We received a request to reset your password. Click the button below to create a new password.</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" class="button">Reset Password</a>
          </p>
          <p>If you didn't request a password reset, you can safely ignore this email.</p>
          <p>This link will expire in 1 hour.</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} UAM. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

    await sendEmail({
        to: email,
        subject: 'Reset Your Password',
        html,
    });
};
