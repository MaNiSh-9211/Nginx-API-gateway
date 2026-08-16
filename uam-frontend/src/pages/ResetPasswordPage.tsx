import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { LockIcon, XIcon } from '../components/Icons';
import { Spinner, Alert } from '../components/FormElements';
import { AuthLayout, AuthCard, AuthHeader } from '../components/AuthLayout';
import { validatePassword } from '../utils/security';

export const ResetPasswordPage: React.FC = () => {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const linkCode = searchParams.get('code');

    const [formToken, setFormToken] = useState<string | null>(null);
    const [formData, setFormData] = useState({
        password: '',
        confirmPassword: ''
    });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<{ type: 'error' | 'success', message: string } | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [redeemError, setRedeemError] = useState('');
    const [isRedeeming, setIsRedeeming] = useState(true);
    const redeemStarted = useRef(false);

    useEffect(() => {
        if (!linkCode) {
            setRedeemError('Invalid or missing reset link.');
            setIsRedeeming(false);
            return;
        }

        if (redeemStarted.current) return;
        redeemStarted.current = true;
        window.history.replaceState({}, '', '/reset-password');

        const redeem = async () => {
            try {
                const redeemed = await api.redeemEmailLink(linkCode);
                if (redeemed.kind !== 'reset-password' || !redeemed.formToken) {
                    setRedeemError('Invalid or expired reset link.');
                    return;
                }
                setFormToken(redeemed.formToken);
            } catch {
                setRedeemError('Invalid or expired reset link.');
            } finally {
                setIsRedeeming(false);
            }
        };

        void redeem();
    }, [linkCode]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        setErrors(prev => ({ ...prev, [name]: '' }));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setErrors({});
        setStatus(null);

        if (!formToken) return;

        const newErrors: Record<string, string> = {};
        const passwordError = validatePassword(formData.password);
        if (passwordError) {
            newErrors.password = passwordError;
        }
        if (formData.password !== formData.confirmPassword) {
            newErrors.confirmPassword = 'Passwords do not match';
        }

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        setIsSubmitting(true);
        try {
            const response = await api.resetPassword(formToken, formData.password);
            if (response.success) {
                setStatus({ type: 'success', message: 'Password reset successfully! Redirecting...' });
                setTimeout(() => navigate('/login', { replace: true }), 2000);
            }
        } catch (error: any) {
            setStatus({ type: 'error', message: error.message || 'Failed to reset password' });
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isRedeeming) {
        return (
            <AuthLayout>
                <AuthCard>
                    <div className="text-center">
                        <Spinner size="lg" />
                        <p style={{ marginTop: 'var(--spacing-4)' }}>Validating reset link...</p>
                    </div>
                </AuthCard>
            </AuthLayout>
        );
    }

    if (redeemError || !formToken) {
        return (
            <AuthLayout>
                <AuthCard>
                    <AuthHeader title="Invalid Link" subtitle={redeemError || 'This password reset link is invalid or expired.'} />
                    <div className="text-center mt-4">
                        <Link to="/forgot-password" className="btn btn-secondary">Request New Link</Link>
                    </div>
                </AuthCard>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout>
            <AuthCard>
                <AuthHeader title="Reset Password" subtitle="Create a new strong password" />

                {status && <Alert type={status.type}>{status.message}</Alert>}

                <form className="auth-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">New Password</label>
                        <div className="input-wrapper">
                            <span className="input-icon"><LockIcon /></span>
                            <input
                                type="password"
                                name="password"
                                className={`form-input ${errors.password ? 'error' : ''}`}
                                placeholder="Min. 8 characters with mixed case, number, symbol"
                                value={formData.password}
                                onChange={handleChange}
                                disabled={isSubmitting}
                                autoComplete="new-password"
                            />
                        </div>
                        {errors.password && <span className="form-error"><XIcon /> {errors.password}</span>}
                    </div>

                    <div className="form-group">
                        <label className="form-label">Confirm Password</label>
                        <div className="input-wrapper">
                            <span className="input-icon"><LockIcon /></span>
                            <input
                                type="password"
                                name="confirmPassword"
                                className={`form-input ${errors.confirmPassword ? 'error' : ''}`}
                                placeholder="Re-enter password"
                                value={formData.confirmPassword}
                                onChange={handleChange}
                                disabled={isSubmitting}
                                autoComplete="new-password"
                            />
                        </div>
                        {errors.confirmPassword && <span className="form-error"><XIcon /> {errors.confirmPassword}</span>}
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary btn-full btn-lg"
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? <Spinner /> : 'Reset Password'}
                    </button>
                </form>
            </AuthCard>
        </AuthLayout>
    );
};
