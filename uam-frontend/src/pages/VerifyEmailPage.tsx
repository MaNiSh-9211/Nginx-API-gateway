import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { CheckCircleIcon, XCircleIcon, LockIcon } from '../components/Icons';
import { Spinner, Alert } from '../components/FormElements';
import { AuthLayout, AuthCard, AuthHeader } from '../components/AuthLayout';
import { validatePassword } from '../utils/security';

const MAX_POLL_ATTEMPTS = 40;

export const VerifyEmailPage: React.FC = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const { setUserFromOAuth } = useAuth();
    const [status, setStatus] = useState<'loading' | 'form' | 'success' | 'error' | 'pending'>('loading');
    const [message, setMessage] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [formError, setFormError] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formToken, setFormToken] = useState<string | null>(null);
    const [cooldown, setCooldown] = useState(0);
    const redeemStarted = useRef(false);
    const emailToVerify = searchParams.get('email');

    useEffect(() => {
        const linkCode = searchParams.get('code');
        const pollToken = searchParams.get('poll');

        if (linkCode) {
            if (redeemStarted.current) return;
            redeemStarted.current = true;
            window.history.replaceState({}, '', '/verify-email');

            const redeem = async () => {
                try {
                    const redeemed = await api.redeemEmailLink(linkCode);
                    if (redeemed.kind !== 'verify-email' || !redeemed.formToken) {
                        setStatus('error');
                        setMessage('Invalid or expired verification link.');
                        return;
                    }
                    setFormToken(redeemed.formToken);
                    setStatus('form');
                    setMessage('Set your password to complete email verification.');
                } catch {
                    setStatus('error');
                    setMessage('Invalid or expired verification link.');
                }
            };
            void redeem();
            return;
        }

        if (pollToken) {
            setStatus('pending');
            setMessage('Check your inbox and complete verification from the email link.');
            window.history.replaceState({}, '', '/verify-email');
            let attempts = 0;

            const pollInterval = setInterval(async () => {
                attempts += 1;
                if (attempts > MAX_POLL_ATTEMPTS) {
                    clearInterval(pollInterval);
                    setMessage('Still waiting for verification. Check your inbox or resend the email.');
                    return;
                }

                try {
                    const { verified } = await api.getVerificationStatus(pollToken);
                    if (verified) {
                        clearInterval(pollInterval);
                        setStatus('success');
                        setMessage('Email verified! Redirecting to login...');
                        setTimeout(() => navigate('/login', { replace: true }), 2500);
                    }
                } catch {
                    // keep polling
                }
            }, 3000);

            return () => clearInterval(pollInterval);
        }

        if (emailToVerify) {
            setStatus('pending');
            setMessage('Check your inbox for the verification link. You can resend below if needed.');
            return;
        }

        setStatus('error');
        setMessage('Invalid verification state');
    }, [searchParams, navigate, emailToVerify]);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval>;
        if (cooldown > 0) {
            timer = setInterval(() => setCooldown((c) => c - 1), 1000);
        }
        return () => clearInterval(timer);
    }, [cooldown]);

    const handleVerifySubmit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!formToken) return;

        const passwordError = validatePassword(password);
        if (passwordError) {
            setFormError(passwordError);
            return;
        }
        if (password !== confirmPassword) {
            setFormError('Passwords do not match');
            return;
        }

        setIsSubmitting(true);
        setFormError('');
        try {
            const response = await api.verifyEmail(formToken, password);
            if (response.success) {
                setStatus('success');
                setMessage('Your email has been verified successfully! Redirecting...');
                if (response.accessToken) {
                    await setUserFromOAuth(response.accessToken, '');
                    setTimeout(() => navigate('/dashboard', { replace: true }), 2000);
                }
            } else {
                setStatus('error');
                setMessage(response.message || 'Verification failed');
            }
        } catch (error: any) {
            setStatus('error');
            setMessage(error.message || 'Verification failed');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleResend = async () => {
        if (!emailToVerify) return;
        try {
            await api.resendVerification(emailToVerify);
            setMessage('If the account exists and is unverified, a verification email has been sent.');
            setCooldown(30);
        } catch {
            setMessage('Failed to resend verification email.');
        }
    };

    return (
        <AuthLayout>
            <AuthCard>
                <AuthHeader title="Email Verification" />
                <div className="text-center">
                    {status === 'loading' && (
                        <div>
                            <Spinner size="lg" />
                            <p style={{ marginTop: 'var(--spacing-4)' }}>Loading...</p>
                        </div>
                    )}

                    {status === 'form' && (
                        <form className="auth-form" onSubmit={handleVerifySubmit}>
                            <p style={{ marginBottom: 'var(--spacing-4)' }}>{message}</p>
                            {formError && <Alert type="error">{formError}</Alert>}
                            <div className="form-group">
                                <label className="form-label">Password</label>
                                <div className="input-wrapper">
                                    <span className="input-icon"><LockIcon /></span>
                                    <input
                                        type="password"
                                        className="form-input"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        disabled={isSubmitting}
                                        autoComplete="new-password"
                                    />
                                </div>
                            </div>
                            <div className="form-group">
                                <label className="form-label">Confirm Password</label>
                                <div className="input-wrapper">
                                    <span className="input-icon"><LockIcon /></span>
                                    <input
                                        type="password"
                                        className="form-input"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        disabled={isSubmitting}
                                        autoComplete="new-password"
                                    />
                                </div>
                            </div>
                            <button type="submit" className="btn btn-primary btn-full" disabled={isSubmitting}>
                                {isSubmitting ? <Spinner /> : 'Verify Email & Set Password'}
                            </button>
                        </form>
                    )}

                    {status === 'pending' && (
                        <div>
                            <Spinner size="lg" />
                            <p style={{ marginTop: 'var(--spacing-4)' }}>{message}</p>
                            {emailToVerify && (
                                <button
                                    onClick={handleResend}
                                    disabled={cooldown > 0}
                                    className="btn btn-secondary btn-full"
                                    style={{ marginTop: 'var(--spacing-4)' }}
                                >
                                    {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend Verification Email'}
                                </button>
                            )}
                        </div>
                    )}

                    {status === 'success' && (
                        <div>
                            <div style={{ color: 'var(--color-success)', display: 'flex', justifyContent: 'center', marginBottom: 'var(--spacing-4)' }}>
                                <CheckCircleIcon size={64} />
                            </div>
                            <p style={{ marginBottom: 'var(--spacing-6)' }}>{message}</p>
                            <Link to="/login" className="btn btn-primary btn-full">
                                Continue to Login
                            </Link>
                        </div>
                    )}

                    {status === 'error' && (
                        <div>
                            <div style={{ color: 'var(--color-error)', display: 'flex', justifyContent: 'center', marginBottom: 'var(--spacing-4)' }}>
                                <XCircleIcon />
                            </div>
                            <p style={{ marginBottom: 'var(--spacing-6)' }}>{message}</p>
                            {emailToVerify && (
                                <button
                                    onClick={handleResend}
                                    disabled={cooldown > 0}
                                    className="btn btn-secondary btn-full"
                                    style={{ marginBottom: 'var(--spacing-4)' }}
                                >
                                    {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend Verification Email'}
                                </button>
                            )}
                            <Link to="/register" className="btn btn-ghost btn-full">
                                Back to Registration
                            </Link>
                        </div>
                    )}
                </div>
            </AuthCard>
        </AuthLayout>
    );
};
