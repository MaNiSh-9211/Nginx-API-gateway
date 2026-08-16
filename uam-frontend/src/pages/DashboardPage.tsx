import React from 'react';
import { useAuth } from '../context/AuthContext';
import { ShieldIcon, CheckCircleIcon } from '../components/Icons';
import { ProfileDropdown } from '../components/ProfileDropdown';

export const DashboardPage: React.FC = () => {
    const { user } = useAuth();

    if (!user) {
        return null;
    }

    return (
        <div className="dashboard-layout">
            <header className="dashboard-header">
                <div className="dashboard-brand">
                    <div className="dashboard-brand-icon">
                        <ShieldIcon size={20} />
                    </div>
                    <span>AuthAdvance</span>
                </div>
                <div className="dashboard-user">
                    <ProfileDropdown user={user} />
                </div>
            </header>

            <main className="dashboard-content">
                <div className="card card-glass welcome-card fade-in">
                    <div className="welcome-icon">
                        <CheckCircleIcon />
                    </div>
                    <h1 className="welcome-title">Welcome, {user.displayName}!</h1>
                    <p className="welcome-text">
                        You have successfully authenticated. Your account is{' '}
                        {user.isEmailVerified ? (
                            <span style={{ color: 'var(--color-success)' }}>verified</span>
                        ) : (
                            <span style={{ color: 'var(--color-warning)' }}>pending verification</span>
                        )}
                        .
                    </p>

                    {user.bio && (
                        <div className="user-bio-section" style={{
                            marginBottom: 'var(--spacing-6)',
                            padding: 'var(--spacing-5)',
                            background: 'rgba(124, 58, 237, 0.05)',
                            border: '1px solid rgba(124, 58, 237, 0.2)',
                            borderRadius: 'var(--radius-lg)',
                            textAlign: 'left'
                        }}>
                            <div className="user-info-label" style={{ marginBottom: 'var(--spacing-2)' }}>Bio</div>
                            <div className="user-info-value" style={{
                                fontStyle: 'italic',
                                color: 'var(--color-text-secondary)',
                                lineHeight: '1.6'
                            }}>"{user.bio}"</div>
                        </div>
                    )}

                    <div className="user-info-grid">
                        <div className="user-info-item">
                            <div className="user-info-label">Email</div>
                            <div className="user-info-value">{user.email}</div>
                        </div>
                        <div className="user-info-item">
                            <div className="user-info-label">Provider</div>
                            <div className="user-info-value" style={{ textTransform: 'capitalize' }}>
                                {user.provider || 'Local'}
                            </div>
                        </div>
                        <div className="user-info-item">
                            <div className="user-info-label">Account Status</div>
                            <div className="user-info-value">
                                {user.isEmailVerified ? '✓ Verified' : '⏳ Pending'}
                            </div>
                        </div>
                        <div className="user-info-item">
                            <div className="user-info-label">Member Since</div>
                            <div className="user-info-value">
                                {user.createdAt
                                    ? new Date(user.createdAt).toLocaleDateString('en-US', {
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                    })
                                    : 'N/A'}
                            </div>
                        </div>
                    </div>
                </div>

            </main>
        </div>
    );
};
