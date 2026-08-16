import React, { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MailIcon, LockIcon, XIcon, UserIcon } from '../components/Icons';
import { Spinner, Alert, InfoAlert } from '../components/FormElements';
import { AuthLayout, AuthCard, AuthHeader, AuthFooter } from '../components/AuthLayout';
import { OAuthButtons, Divider } from '../components/OAuthButtons';
import { AuthVisualSide } from '../components/AuthVisualSide';
import { getRecentAccounts, removeRecentAccount, type RecentAccount } from '../utils/recentAccounts';
import { api } from '../api/client';

export const LoginPage: React.FC = () => {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { login, isAuthenticated } = useAuth();

    const [formData, setFormData] = useState({
        email: '',
        password: '',
    });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [serverError, setServerError] = useState('');
    const [conflictInfo, setConflictInfo] = useState<{ provider: string } | null>(null);
    const [recentAccounts, setRecentAccounts] = useState<RecentAccount[]>([]);

    useEffect(() => {
        if (isAuthenticated) {
            navigate('/dashboard');
        }
    }, [isAuthenticated, navigate]);

    useEffect(() => {
        setRecentAccounts(getRecentAccounts());
    }, []);

    useEffect(() => {
        const oauthError = searchParams.get('error');
        if (oauthError === 'oauth_not_configured') {
            setServerError('Google/GitHub sign-in is not configured. Add credentials to dev/.env.dev and restart uam-backend.');
        } else if (oauthError === 'oauth_failed') {
            setServerError('OAuth sign-in failed. Please try again or use email and password.');
        }
    }, [searchParams]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        setErrors(prev => ({ ...prev, [name]: '' }));
        setServerError('');
        setConflictInfo(null);
    };

    const handleRecentClick = (account: RecentAccount) => {
        if (account.provider !== 'local') {
            void api.startOAuth(
                account.provider === 'google' ? 'google' : 'github',
                account.provider === 'google' ? { email: account.email } : undefined,
            );
        } else {
            // Pre-fill email for local users
            setFormData(prev => ({ ...prev, email: account.email }));
        }
    };

    const handleRemoveRecent = (e: React.MouseEvent, email: string) => {
        e.stopPropagation();
        removeRecentAccount(email);
        setRecentAccounts(getRecentAccounts());
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setServerError('');

        // Basic validation
        const newErrors: Record<string, string> = {};
        if (!formData.email) newErrors.email = 'Email is required';
        if (!formData.password) newErrors.password = 'Password is required';

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        setIsSubmitting(true);
        try {
            const response = await login(formData.email, formData.password);
            if (response.success) {
                navigate('/dashboard');
            }
        } catch (error: any) {
            setServerError(error.message || 'Invalid email or password');
        } finally {
            setIsSubmitting(false);
        }
    };

    const visualSide = (
        <AuthVisualSide
            title="Welcome Back"
            description="Sign in to access your secure account and continue your journey with us."
            features={[
                'Secure authentication',
                'Fast & reliable access',
                'Your data protected'
            ]}
        />
    );

    return (
        <AuthLayout visualSide={visualSide}>
            <AuthCard>
                <AuthHeader title="Welcome Back" subtitle="Sign in to continue to your account" />

                {serverError && <Alert type="error">{serverError}</Alert>}

                {conflictInfo && (
                    <InfoAlert title={`Account Exists via ${conflictInfo.provider}`}>
                        You previously signed up using your <strong>{conflictInfo.provider}</strong> account with this email address.
                        <br /><br />
                        For security reasons, you cannot log in using a password. Please use the <strong>"Continue with {conflictInfo.provider}"</strong> button below to access your account.
                    </InfoAlert>
                )}

                {recentAccounts.length > 0 && (
                    <div className="recent-accounts-section">
                        <h3 className="recent-accounts-title">
                            <UserIcon size={14} /> Continue as...
                        </h3>
                        <div className="recent-accounts-list">
                            {recentAccounts.map(account => (
                                <div
                                    key={account.email}
                                    className="recent-account-card"
                                    onClick={() => handleRecentClick(account)}
                                >
                                    <div className="recent-account-info">
                                        <div className="recent-account-avatar">
                                            {account.avatar ? (
                                                <img src={account.avatar} alt={account.displayName} />
                                            ) : (
                                                account.displayName.charAt(0).toUpperCase()
                                            )}
                                        </div>
                                        <div className="recent-account-details">
                                            <span className="recent-account-name">{account.displayName}</span>
                                            <span className="recent-account-email">{account.email}</span>
                                        </div>
                                    </div>
                                    <button
                                        className="recent-account-remove"
                                        onClick={(e) => handleRemoveRecent(e, account.email)}
                                        title="Remove account"
                                    >
                                        <XIcon size={14} />
                                    </button>
                                </div>
                            ))}
                        </div>
                        <Divider />
                    </div>
                )}

                <form className="auth-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">Email</label>
                        <div className="input-wrapper">
                            <span className="input-icon"><MailIcon /></span>
                            <input
                                type="email"
                                name="email"
                                className={`form-input ${errors.email ? 'error' : ''}`}
                                placeholder="you@example.com"
                                value={formData.email}
                                onChange={handleChange}
                            />
                        </div>
                        {errors.email && <span className="form-error"><XIcon /> {errors.email}</span>}
                    </div>

                    <div className="form-group">
                        <label className="form-label">Password</label>
                        <div className="input-wrapper">
                            <span className="input-icon"><LockIcon /></span>
                            <input
                                type="password"
                                name="password"
                                className={`form-input ${errors.password ? 'error' : ''}`}
                                placeholder="Enter your password"
                                value={formData.password}
                                onChange={handleChange}
                            />
                        </div>
                        {errors.password && <span className="form-error"><XIcon /> {errors.password}</span>}
                    </div>

                    <div className="flex justify-between items-center">
                        <Link to="/forgot-password" className="text-sm">Forgot password?</Link>
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary btn-full btn-lg"
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? <Spinner /> : 'Sign In'}
                    </button>
                </form>

                <OAuthButtons onOAuthError={setServerError} />

                <AuthFooter>
                    Don't have an account? <Link to="/register">Create one</Link>
                </AuthFooter>
            </AuthCard>
        </AuthLayout>
    );
};
