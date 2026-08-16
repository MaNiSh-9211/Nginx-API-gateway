import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
    MailIcon,
    LockIcon,
    UserIcon,
    XIcon,
} from '../components/Icons';
import { PasswordStrength, Spinner, Alert, InfoAlert } from '../components/FormElements';
import { AuthLayout, AuthCard, AuthHeader, AuthFooter } from '../components/AuthLayout';
import { OAuthButtons, Divider } from '../components/OAuthButtons';
import { AuthVisualSide } from '../components/AuthVisualSide';

export const RegisterPage: React.FC = () => {
    const navigate = useNavigate();
    const { register, isAuthenticated } = useAuth();

    const [formData, setFormData] = useState({
        displayName: '',
        email: '',
        password: '',
    });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [serverError, setServerError] = useState('');
    const [conflictInfo, setConflictInfo] = useState<{ provider: string } | null>(null);

    useEffect(() => {
        if (isAuthenticated) {
            navigate('/dashboard');
        }
    }, [isAuthenticated, navigate]);

    // Email availability is validated only on submit (prevents enumeration via live checks).
    const validateField = useCallback((name: string, value: string): string => {
        switch (name) {
            case 'displayName':
                if (!value) return 'Display name is required';
                if (value.length < 2) return 'Display name must be at least 2 characters';
                if (value.length > 50) return 'Display name is too long';
                return '';
            case 'email':
                if (!value) return 'Email is required';
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Invalid email format';
                return '';
            case 'password':
                if (!value) return 'Password is required';
                if (value.length < 8) return 'Password must be at least 8 characters';
                if (!/[A-Z]/.test(value)) return 'Password must contain an uppercase letter';
                if (!/[a-z]/.test(value)) return 'Password must contain a lowercase letter';
                if (!/[0-9]/.test(value)) return 'Password must contain a number';
                if (!/[^A-Za-z0-9]/.test(value)) return 'Password must contain a special character';
                return '';
            default:
                return '';
        }
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        setErrors(prev => ({ ...prev, [name]: validateField(name, value) }));
        setServerError('');
        setConflictInfo(null);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setServerError('');

        // Validate all fields
        const newErrors: Record<string, string> = {};
        Object.entries(formData).forEach(([key, value]) => {
            const error = validateField(key, value);
            if (error) newErrors[key] = error;
        });

        if (Object.keys(newErrors).length > 0) {
            setErrors(newErrors);
            return;
        }

        setIsSubmitting(true);
        try {
            const response = await register(formData.email, formData.password, formData.displayName);
            if (response.success) {
                if (response.accessToken) {
                    navigate('/dashboard');
                } else {
                    const poll = response.verificationPollToken;
                    const q = new URLSearchParams();
                    q.set('email', formData.email);
                    if (poll) q.set('poll', poll);
                    navigate(`/verify-email?${q.toString()}`);
                }
            }
        } catch (error: any) {
            if (error.code === 'PROVIDER_MISMATCH') {
                setConflictInfo({ provider: error.provider });
                return;
            }
            setServerError(error instanceof Error ? error.message : 'Registration failed');
        } finally {
            setIsSubmitting(false);
        }
    };



    const visualSide = (
        <AuthVisualSide
            title="Join Us Today"
            description="Create your account and unlock a world of possibilities with our secure platform."
            features={[
                'Free account creation',
                'Email verification',
                'Secure password protection'
            ]}
        />
    );

    return (
        <AuthLayout visualSide={visualSide}>
            <AuthCard>
                <AuthHeader title="Create Account" subtitle="Join us and start your journey" />

                {serverError && <Alert type="error">{serverError}</Alert>}

                {conflictInfo && (
                    <InfoAlert title={`Account Exists via ${conflictInfo.provider}`}>
                        This email address is already associated with an account created via <strong>{conflictInfo.provider}</strong>.
                        <br /><br />
                        You don't need to create a new password. Please use the <strong>"Continue with {conflictInfo.provider}"</strong> button below to access your existing account.
                    </InfoAlert>
                )}

                <form className="auth-form" onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">Display Name</label>
                        <div className="input-wrapper">
                            <span className="input-icon"><UserIcon /></span>
                            <input
                                type="text"
                                name="displayName"
                                className={`form-input ${errors.displayName ? 'error' : ''}`}
                                placeholder="John Doe"
                                value={formData.displayName}
                                onChange={handleChange}
                            />
                        </div>
                        {errors.displayName && <span className="form-error"><XIcon /> {errors.displayName}</span>}
                    </div>

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
                                placeholder="Create a strong password"
                                value={formData.password}
                                onChange={handleChange}
                            />
                        </div>
                        <PasswordStrength password={formData.password} />
                        {errors.password && <span className="form-error"><XIcon /> {errors.password}</span>}
                    </div>

                    <button
                        type="submit"
                        className="btn btn-primary btn-full btn-lg"
                        disabled={isSubmitting}
                    >
                        {isSubmitting ? <Spinner /> : 'Create Account'}
                    </button>
                </form>

                <Divider />
                <OAuthButtons />

                <AuthFooter>
                    Already have an account? <Link to="/login">Sign in</Link>
                </AuthFooter>
            </AuthCard>
        </AuthLayout>
    );
};
