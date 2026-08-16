import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner, Alert } from '../components/FormElements';
import { AuthLayout, AuthCard, AuthHeader } from '../components/AuthLayout';
import { CheckCircleIcon, XCircleIcon } from '../components/Icons';

export const MigrationVerifyPage: React.FC = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
    const [message, setMessage] = useState('');
    const redeemStarted = useRef(false);

    useEffect(() => {
        const code = searchParams.get('code');
        if (!code) {
            setStatus('error');
            setMessage('Invalid migration verification link.');
            return;
        }

        if (redeemStarted.current) return;
        redeemStarted.current = true;
        window.history.replaceState({}, '', '/migrate/verify');

        const run = async () => {
            try {
                const redeemed = await api.redeemEmailLink(code);
                if (!redeemed.formToken || !redeemed.kind?.startsWith('migrate-')) {
                    setStatus('error');
                    setMessage('Invalid or expired migration link.');
                    return;
                }

                const result = redeemed.kind === 'migrate-current'
                    ? await api.verifyCurrentEmail(redeemed.formToken)
                    : await api.verifyNewEmail(redeemed.formToken);

                if (!result.success) {
                    setStatus('error');
                    setMessage(result.message || 'Migration verification failed.');
                    return;
                }

                setStatus('success');
                setMessage(result.message || 'Email verified successfully.');

                const redirect = redeemed.meta?.redirect;
                setTimeout(() => {
                    if (redirect === 'login') {
                        navigate('/login', { replace: true });
                    } else if (redirect === 'signup') {
                        navigate('/register', { replace: true });
                    } else {
                        navigate('/login', { replace: true });
                    }
                }, 3000);
            } catch (error: any) {
                setStatus('error');
                setMessage(error.message || 'Migration verification failed.');
            }
        };

        void run();
    }, [searchParams, navigate]);

    return (
        <AuthLayout>
            <AuthCard>
                <AuthHeader title="Migration Verification" />
                <div className="text-center">
                    {status === 'loading' && (
                        <div>
                            <Spinner size="lg" />
                            <p style={{ marginTop: 'var(--spacing-4)' }}>Verifying your email...</p>
                        </div>
                    )}
                    {status === 'success' && (
                        <div>
                            <div style={{ color: 'var(--color-success)', display: 'flex', justifyContent: 'center', marginBottom: 'var(--spacing-4)' }}>
                                <CheckCircleIcon size={64} />
                            </div>
                            <Alert type="success">{message}</Alert>
                            <Link to="/login" className="btn btn-primary btn-full" style={{ marginTop: 'var(--spacing-4)' }}>
                                Continue to Login
                            </Link>
                        </div>
                    )}
                    {status === 'error' && (
                        <div>
                            <div style={{ color: 'var(--color-error)', display: 'flex', justifyContent: 'center', marginBottom: 'var(--spacing-4)' }}>
                                <XCircleIcon />
                            </div>
                            <Alert type="error">{message}</Alert>
                            <Link to="/login" className="btn btn-secondary btn-full" style={{ marginTop: 'var(--spacing-4)' }}>
                                Back to Login
                            </Link>
                        </div>
                    )}
                </div>
            </AuthCard>
        </AuthLayout>
    );
};
