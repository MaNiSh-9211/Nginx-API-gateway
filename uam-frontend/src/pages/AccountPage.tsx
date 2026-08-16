import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { MailIcon, UserIcon, EditIcon, CheckIcon, XIcon } from '../components/Icons';
import { Spinner, Alert } from '../components/FormElements';
import { ShieldIcon } from '../components/Icons';

export const AccountPage: React.FC = () => {
    const { user, refreshUser } = useAuth();
    const [isEditingBio, setIsEditingBio] = useState(false);
    const [bio, setBio] = useState(user?.bio || '');
    const [status, setStatus] = useState({ loading: false, error: '', success: '' });

    if (!user) {
        return null;
    }

    const handleSaveBio = async () => {
        if (bio.length > 500) {
            setStatus({ loading: false, error: 'Bio must be 500 characters or less', success: '' });
            return;
        }

        setStatus({ loading: true, error: '', success: '' });
        try {
            const result = await api.updateBio(bio);
            if (result.success) {
                setStatus({ loading: false, error: '', success: 'Bio updated successfully!' });
                setIsEditingBio(false);
                await refreshUser();
            } else {
                setStatus({ loading: false, error: result.message || 'Failed to update bio', success: '' });
            }
        } catch (error: any) {
            setStatus({ loading: false, error: error.message || 'Failed to update bio', success: '' });
        }
    };

    const handleCancelEdit = () => {
        setBio(user.bio || '');
        setIsEditingBio(false);
        setStatus({ loading: false, error: '', success: '' });
    };

    const getInitials = (name: string) => {
        return name
            .split(' ')
            .map((n) => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);
    };

    return (
        <div className="dashboard-layout">
            <header className="dashboard-header">
                <div className="dashboard-brand">
                    <div className="dashboard-brand-icon">
                        <ShieldIcon size={20} />
                    </div>
                    <span>AuthAdvance</span>
                </div>
            </header>

            <main className="dashboard-content">
                <div className="account-page-container">
                    <div className="account-header">
                        <div className="account-avatar-large">
                            {user.avatar ? (
                                <img src={user.avatar} alt={user.displayName} />
                            ) : (
                                getInitials(user.displayName)
                            )}
                        </div>
                        <div className="account-header-info">
                            <h1 className="account-title">{user.displayName}</h1>
                            <p className="account-email">{user.email}</p>
                        </div>
                    </div>

                    {status.error && <Alert type="error">{status.error}</Alert>}
                    {status.success && <Alert type="success">{status.success}</Alert>}

                    <div className="account-section">
                        <div className="account-section-header">
                            <h2 className="account-section-title">
                                <UserIcon size={20} />
                                Profile Information
                            </h2>
                        </div>

                        <div className="account-info-grid">
                            <div className="account-info-item">
                                <label className="account-info-label">Display Name</label>
                                <div className="account-info-value">{user.displayName}</div>
                            </div>
                            <div className="account-info-item">
                                <label className="account-info-label">Email</label>
                                <div className="account-info-value">{user.email}</div>
                            </div>
                            <div className="account-info-item">
                                <label className="account-info-label">Provider</label>
                                <div className="account-info-value" style={{ textTransform: 'capitalize' }}>
                                    {user.provider || 'Local'}
                                </div>
                            </div>
                            <div className="account-info-item">
                                <label className="account-info-label">Account Status</label>
                                <div className="account-info-value">
                                    {user.isEmailVerified ? (
                                        <span style={{ color: 'var(--color-success)' }}>✓ Verified</span>
                                    ) : (
                                        <span style={{ color: 'var(--color-warning)' }}>⏳ Pending</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="account-section">
                        <div className="account-section-header">
                            <h2 className="account-section-title">
                                <EditIcon size={20} />
                                Bio
                            </h2>
                            {!isEditingBio && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => setIsEditingBio(true)}
                                >
                                    <EditIcon size={16} />
                                    Edit Bio
                                </button>
                            )}
                        </div>

                        {isEditingBio ? (
                            <div className="bio-edit-container">
                                <textarea
                                    className="bio-textarea"
                                    value={bio}
                                    onChange={(e) => setBio(e.target.value)}
                                    placeholder="Tell us about yourself..."
                                    maxLength={500}
                                    rows={6}
                                />
                                <div className="bio-edit-footer">
                                    <span className="bio-character-count">
                                        {bio.length}/500 characters
                                    </span>
                                    <div className="bio-edit-actions">
                                        <button
                                            className="btn btn-ghost btn-sm"
                                            onClick={handleCancelEdit}
                                            disabled={status.loading}
                                        >
                                            <XIcon size={16} />
                                            Cancel
                                        </button>
                                        <button
                                            className="btn btn-primary btn-sm"
                                            onClick={handleSaveBio}
                                            disabled={status.loading}
                                        >
                                            {status.loading ? (
                                                <Spinner size="sm" />
                                            ) : (
                                                <>
                                                    <CheckIcon size={16} />
                                                    Save
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="bio-display">
                                {user.bio ? (
                                    <p className="bio-text">"{user.bio}"</p>
                                ) : (
                                    <p className="bio-placeholder">No bio added yet. Click "Edit Bio" to add one.</p>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="account-section">
                        <div className="account-section-header">
                            <h2 className="account-section-title">
                                <MailIcon size={20} />
                                Account Migration
                            </h2>
                        </div>
                        <div className="account-actions">
                            <a href="/migrate" className="btn btn-primary btn-full" style={{ fontSize: '1rem', padding: 'var(--spacing-3)' }}>
                                Migrate Account
                            </a>
                            <p style={{ marginTop: 'var(--spacing-2)', fontSize: '0.875rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                                Change your email address and transfer your account data
                            </p>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
};

