import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { MailIcon, XIcon } from '../components/Icons';
import { Spinner, Alert } from '../components/FormElements';
import { AuthLayout, AuthCard, AuthHeader, AuthFooter } from '../components/AuthLayout';

export const ForgotPasswordPage: React.FC = () => {
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        if (!email) {
            setError('Email is required');
            return;
        }

        setIsSubmitting(true);
        try {
            const response = await api.forgotPassword(email);
            if (response.success) {
                setSuccess(response.message || 'If an account exists, a reset link has been sent.');
                // Keep email to display it
            }
        } catch (err: any) {
            // Generic error message for security on production, but helpful here
            setError(err.message || 'Failed to request password reset');
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <AuthLayout>
            <AuthCard>
                <AuthHeader
                    title="Forgot Password?"
                    subtitle="Enter your email to receive a reset link"
                />

                {error && <Alert type="error">{error}</Alert>}
                {success && <Alert type="success">{success}</Alert>}

                {success ? (
                    <div className="text-center">
                        <div style={{ color: 'var(--color-success)', display: 'flex', justifyContent: 'center', marginBottom: 'var(--spacing-4)' }}>
                            <MailIcon />
                        </div>
                        <h3 style={{ marginBottom: 'var(--spacing-2)' }}>Check your email</h3>
                        <p style={{ color: 'var(--color-text-secondary)', marginBottom: 'var(--spacing-6)' }}>
                            We've sent a password reset link to <br /><strong>{email}</strong>
                        </p>
                        <div className="text-center">
                            <Link to="/login" className="btn btn-secondary btn-full">
                                Back to Login
                            </Link>
                        </div>
                    </div>
                ) : (
                    <form className="auth-form" onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label className="form-label">Email Address</label>
                            <div className="input-wrapper">
                                <span className="input-icon"><MailIcon /></span>
                                <input
                                    type="email"
                                    className={`form-input ${error ? 'error' : ''}`}
                                    placeholder="you@example.com"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    disabled={isSubmitting}
                                />
                            </div>
                            {error && <span className="form-error"><XIcon /> {error}</span>}
                        </div>

                        <button
                            type="submit"
                            className="btn btn-primary btn-full btn-lg"
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? <Spinner /> : 'Send Reset Link'}
                        </button>
                    </form>
                )}

                <AuthFooter>
                    Remember your password? <Link to="/login">Sign In</Link>
                </AuthFooter>
            </AuthCard>
        </AuthLayout>
    );
};
