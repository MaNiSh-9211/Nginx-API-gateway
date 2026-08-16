import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { LockIcon, MailIcon, CheckIcon } from '../components/Icons';
import { Spinner, Alert } from '../components/FormElements';
import { AuthLayout, AuthCard, AuthHeader } from '../components/AuthLayout';

interface MigrationStatus {
    hasPendingMigration: boolean;
    currentEmail: string;
    newEmail: string | null;
    currentEmailVerified: boolean;
    newEmailVerified: boolean;
    migrationExpiry: string | null;
    cooldownRemaining: number;
}

export const MigrationPage: React.FC = () => {
    const { user, refreshUser } = useAuth();

    const [formData, setFormData] = useState({
        password: '',
        newEmail: '',
    });
    const [status, setStatus] = useState({ loading: false, error: '', success: '' });
    const [migrationStatus, setMigrationStatus] = useState<MigrationStatus | null>(null);
    const [, setIsPolling] = useState(false);
    const [cooldown, setCooldown] = useState(0);
    const [isResending, setIsResending] = useState(false);
    const [emailExistsWarning, setEmailExistsWarning] = useState<{ exists: boolean } | null>(null);
    const [migrationHistory, setMigrationHistory] = useState<Array<{
        fromEmail: string;
        toEmail: string;
        status: 'success' | 'failed' | 'pending' | 'reverted';
        initiatedAt: string;
        completedAt?: string;
        revertedAt?: string;
        currentEmailVerified?: boolean;
        newEmailVerified?: boolean;
        pendingFrom?: 'current' | 'new' | 'both';
    }>>([]);
    const [showHistory, setShowHistory] = useState(false);

    // Cooldown timer
    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setInterval(() => {
            setCooldown(prev => Math.max(0, prev - 1));
        }, 1000);
        return () => clearInterval(timer);
    }, [cooldown]);

    // Check migration status - returns status for immediate updates
    const checkMigrationStatus = async () => {
        try {
            const result = await api.getMigrationStatus();
            if (result.success) {
                // Force update with explicit values to ensure re-render
                const updatedStatus = {
                    hasPendingMigration: result.hasPendingMigration,
                    currentEmail: result.currentEmail,
                    newEmail: result.newEmail,
                    currentEmailVerified: result.currentEmailVerified || false,
                    newEmailVerified: result.newEmailVerified || false,
                    migrationExpiry: result.migrationExpiry,
                    cooldownRemaining: result.cooldownRemaining || 0
                };
                setMigrationStatus(updatedStatus);
                
                // Update cooldown from server
                if (result.cooldownRemaining > 0) {
                    setCooldown(result.cooldownRemaining);
                }

                // If both verified, trigger finalization
                if (result.currentEmailVerified && result.newEmailVerified) {
                    // Check if finalization is needed
                    if (result.needsFinalization || result.hasPendingMigration) {
                        try {
                            const finalizeResult = await api.finalizeMigration();
                            
                            if (finalizeResult.success) {
                                await refreshUser();
                                setIsPolling(false);
                                setMigrationStatus(null);
                                setStatus({ loading: false, error: '', success: 'Migration completed successfully! You can start a new migration below.' });
                            } else {
                                setStatus({ loading: false, error: finalizeResult.message || 'Failed to finalize migration', success: '' });
                            }
                        } catch (error: any) {
                            console.error('Finalization error:', error);
                            setStatus({ loading: false, error: error.message || 'Failed to finalize migration', success: '' });
                        }
                    } else {
                        // Already finalized
                        await refreshUser();
                        setIsPolling(false);
                        setMigrationStatus(null);
                        setStatus({ loading: false, error: '', success: 'Migration completed successfully! You can start a new migration below.' });
                    }
                } else if (result.currentEmailVerified || result.newEmailVerified) {
                    // One is verified, show update
                    setStatus({
                        loading: false,
                        error: '',
                        success: result.currentEmailVerified && result.newEmailVerified 
                            ? 'Both emails verified! Finalizing migration...'
                            : `${result.currentEmailVerified ? 'Current' : 'New'} email verified! Waiting for the other...`,
                    });
                }
                return updatedStatus;
            }
            return null;
        } catch (error: any) {
            console.error('Failed to check migration status:', error);
            return null;
        }
    };

    const handleResendEmails = async () => {
        // Only allow resend if there's a pending migration
        if (!migrationStatus?.hasPendingMigration) {
            setStatus({ loading: false, error: 'No pending migration to resend emails for', success: '' });
            return;
        }

        setIsResending(true);
        setStatus({ loading: true, error: '', success: '' });

        try {
            const result = await api.resendMigrationEmails();
            if (result.success) {
                setStatus({
                    loading: false,
                    error: '',
                    success: 'Verification emails resent to both email addresses!',
                });
                setCooldown(30); // Start 30-second cooldown
                await checkMigrationStatus();
                // Clear success message after 3 seconds
                setTimeout(() => {
                    setStatus(prev => ({ ...prev, success: '' }));
                }, 3000);
            } else {
                setStatus({ loading: false, error: result.message || 'Failed to resend emails', success: '' });
                if (typeof result.cooldownRemaining === 'number') {
                    setCooldown(result.cooldownRemaining);
                }
            }
        } catch (error: any) {
            setStatus({ loading: false, error: error.message || 'Failed to resend emails', success: '' });
            if (error.cooldownRemaining) {
                setCooldown(error.cooldownRemaining);
            }
        } finally {
            setIsResending(false);
        }
    };

    // Poll for migration status if there's a pending migration - REAL-TIME UPDATES
    useEffect(() => {
        // Only start polling if there's a pending migration
        if (!migrationStatus?.hasPendingMigration) {
            setIsPolling(false);
            return;
        }

        // Stop if both are already verified - handle completion
        if (migrationStatus.currentEmailVerified && migrationStatus.newEmailVerified) {
            setIsPolling(false);
            // Migration complete - refresh user and show in history
            refreshUser().then(() => {
                setTimeout(() => {
                    setMigrationStatus(null);
                    setStatus({ loading: false, error: '', success: '' });
                    setShowHistory(true); // Show history instead of success message
                }, 1000);
            });
            return;
        }

        setIsPolling(true);
        let isCancelled = false;
        
        // Poll every 2 seconds for real-time updates
        const interval = setInterval(async () => {
            if (isCancelled) return;
            
            try {
                const result = await api.getMigrationStatus();
                if (result.success && !isCancelled) {
                    // Always update status for real-time display - CRITICAL for status updates
                    if (result.hasPendingMigration) {
                        // Force update to trigger re-render and show real-time status
                        setMigrationStatus({
                            hasPendingMigration: result.hasPendingMigration,
                            currentEmail: result.currentEmail,
                            newEmail: result.newEmail,
                            currentEmailVerified: result.currentEmailVerified || false,
                            newEmailVerified: result.newEmailVerified || false,
                            migrationExpiry: result.migrationExpiry,
                            cooldownRemaining: result.cooldownRemaining || 0
                        });
                        // Update cooldown from server
                        if (result.cooldownRemaining > 0) {
                            setCooldown(result.cooldownRemaining);
                        }
                    }
                    
                    // If both verified, stop polling and handle completion
                    if (result.currentEmailVerified && result.newEmailVerified) {
                        clearInterval(interval);
                        setIsPolling(false);
                        await refreshUser();
                        // Clear status and show in history instead of success message
                        setTimeout(() => {
                            setMigrationStatus(null);
                            setStatus({ loading: false, error: '', success: '' });
                            setShowHistory(true); // Show history instead of success message
                        }, 1000);
                        return;
                    }
                }
            } catch (error) {
                console.error('Polling error:', error);
            }
        }, 2000);

        return () => {
            isCancelled = true;
            clearInterval(interval);
            setIsPolling(false);
        };
    }, [migrationStatus?.hasPendingMigration, refreshUser]); // Include refreshUser in dependencies

    useEffect(() => {
        if (user) {
            void checkMigrationStatus();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadMigrationHistory = React.useCallback(async () => {
        try {
            const result = await api.getMigrationHistory();
            if (result.success) {
                const history = result.history || [];
                setMigrationHistory(history);
            }
        } catch (error) {
            console.error('Failed to load migration history:', error);
        }
    }, []);

    // Load history only when history modal is opened (not on every render)
    useEffect(() => {
        if (showHistory) {
            loadMigrationHistory();
        }
    }, [showHistory, loadMigrationHistory]);

    // Load history only when history modal is opened (not on every render)
    useEffect(() => {
        if (showHistory) {
            loadMigrationHistory();
        }
    }, [showHistory]); // Only load when showHistory changes

    const handleSubmit = async (e: React.FormEvent, confirmOverride: boolean = false) => {
        e.preventDefault();
        setStatus({ loading: true, error: '', success: '' });
        setEmailExistsWarning(null);

        try {
            const result = await api.initiateMigration(formData.password, formData.newEmail, confirmOverride);
            if (result.success) {
                setStatus({
                    loading: false,
                    error: '',
                    success: 'Verification links sent to both email addresses! Please check your emails.',
                });
                setCooldown(30); // Start 30-second cooldown
                setEmailExistsWarning(null);
                await checkMigrationStatus();
            } else {
                // Check if email exists and requires confirmation
                if (result.code === 'EMAIL_EXISTS' && result.requiresConfirmation) {
                    setEmailExistsWarning({ exists: true });
                    setStatus({ 
                        loading: false, 
                        error: result.warning ?? result.message ?? 'Confirmation required', 
                        success: '' 
                    });
                } else {
                    setStatus({ loading: false, error: result.message || 'Failed to initiate migration', success: '' });
                }
            }
        } catch (error: any) {
            if (error.code === 'EMAIL_EXISTS' && error.requiresConfirmation) {
                setEmailExistsWarning({ exists: true });
                setStatus({ 
                    loading: false, 
                    error: error.warning ?? error.message ?? 'Confirmation required', 
                    success: '' 
                });
            } else {
                setStatus({ loading: false, error: error.message || 'Failed to initiate migration', success: '' });
            }
        }
    };

    const handleConfirmOverride = async (e: React.FormEvent) => {
        await handleSubmit(e, true);
    };

    // Show migration history modal
    if (showHistory) {
        return (
            <AuthLayout>
                <AuthCard>
                    <AuthHeader
                        title="Migration History"
                        subtitle="View all your account migration attempts"
                    />
                    <div style={{ marginBottom: 'var(--spacing-4)' }}>
                        <button
                            className="btn btn-secondary"
                            onClick={() => {
                                setShowHistory(false);
                            }}
                        >
                            ← Back
                        </button>
                    </div>
                    <div className="migration-history-section">
                        {migrationHistory.length === 0 ? (
                            <p style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: 'var(--spacing-4)' }}>
                                No migration history found.
                            </p>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-3)' }}>
                                {migrationHistory.map((migration, index) => (
                                    <div
                                        key={index}
                                        style={{
                                            padding: 'var(--spacing-3)',
                                            background: 'rgba(255, 255, 255, 0.05)',
                                            borderRadius: 'var(--radius-md)',
                                            border: `1px solid ${
                                                migration.status === 'success' ? 'rgba(34, 197, 94, 0.3)' :
                                                migration.status === 'failed' ? 'rgba(239, 68, 68, 0.3)' :
                                                migration.status === 'pending' ? 'rgba(251, 191, 36, 0.3)' :
                                                'rgba(107, 114, 128, 0.3)'
                                            }`
                                        }}
                                    >
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-2)' }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', marginBottom: 'var(--spacing-1)' }}>
                                                    <span style={{
                                                        padding: '4px 8px',
                                                        borderRadius: 'var(--radius-sm)',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 'bold',
                                                        background: migration.status === 'success' ? 'rgba(34, 197, 94, 0.2)' :
                                                                    migration.status === 'failed' ? 'rgba(239, 68, 68, 0.2)' :
                                                                    migration.status === 'pending' ? 'rgba(251, 191, 36, 0.2)' :
                                                                    'rgba(107, 114, 128, 0.2)',
                                                        color: migration.status === 'success' ? '#22c55e' :
                                                               migration.status === 'failed' ? '#ef4444' :
                                                               migration.status === 'pending' ? '#fbbf24' :
                                                               '#6b7280'
                                                    }}>
                                                        {migration.status.toUpperCase()}
                                                    </span>
                                                </div>
                                                <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>
                                                    <strong>From:</strong> {migration.fromEmail}
                                                </p>
                                                <p style={{ margin: '4px 0', fontSize: '0.9rem' }}>
                                                    <strong>To:</strong> {migration.toEmail}
                                                </p>
                                                {migration.status === 'pending' && migration.pendingFrom && (
                                                    <p style={{ margin: '4px 0', fontSize: '0.85rem', color: 'var(--color-warning)', fontWeight: '500' }}>
                                                        ⏳ Pending: {migration.pendingFrom === 'both' 
                                                            ? 'Both emails need verification' 
                                                            : migration.pendingFrom === 'current' 
                                                            ? `Waiting for current email (${migration.fromEmail}) verification`
                                                            : `Waiting for new email (${migration.toEmail}) verification`}
                                                    </p>
                                                )}
                                                {migration.status === 'pending' && (
                                                    <div style={{ marginTop: 'var(--spacing-2)', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                        <p style={{ margin: '2px 0' }}>
                                                            Current Email: {migration.currentEmailVerified ? '✓ Verified' : '⏳ Pending'}
                                                        </p>
                                                        <p style={{ margin: '2px 0' }}>
                                                            New Email: {migration.newEmailVerified ? '✓ Verified' : '⏳ Pending'}
                                                        </p>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 'var(--spacing-2)' }}>
                                            <p style={{ margin: '2px 0' }}>
                                                <strong>Initiated:</strong> {new Date(migration.initiatedAt).toLocaleString()}
                                            </p>
                                            {migration.completedAt && (
                                                <p style={{ margin: '2px 0' }}>
                                                    <strong>Completed:</strong> {new Date(migration.completedAt).toLocaleString()}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </AuthCard>
            </AuthLayout>
        );
    }

    // Show verification status ONLY if migration is pending
    if (migrationStatus?.hasPendingMigration) {
        return (
            <AuthLayout>
                <AuthCard>
                    <AuthHeader
                        title="Account Migration"
                        subtitle="Verify both email addresses to complete migration"
                    />

                    {status.error && <Alert type="error">{status.error}</Alert>}
                    {status.success && <Alert type="success">{status.success}</Alert>}

                    <div className="migration-status-container">
                        <div className="migration-instructions">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--spacing-4)' }}>
                                <h3>Migration Instructions</h3>
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={handleResendEmails}
                                    disabled={cooldown > 0 || isResending || status.loading || !migrationStatus.hasPendingMigration}
                                    style={{ whiteSpace: 'nowrap' }}
                                >
                                    {isResending ? (
                                        <>
                                            <Spinner size="sm" />
                                            Resending...
                                        </>
                                    ) : cooldown > 0 ? (
                                        `Resend (${cooldown}s)`
                                    ) : (
                                        'Resend Emails'
                                    )}
                                </button>
                            </div>
                            <p>
                                To complete your account migration, you need to verify both email addresses.
                                Check your email inboxes and click the verification links.
                            </p>
                            <ul>
                                <li>Verify your <strong>current email</strong> ({migrationStatus.currentEmail})</li>
                                <li>Verify your <strong>new email</strong> ({migrationStatus.newEmail})</li>
                                <li>Once both are verified, your account will be migrated automatically</li>
                                <li>You'll be able to login with both emails for 5 days</li>
                                <li><strong>Note:</strong> Old verification links become invalid when you resend emails</li>
                            </ul>
                        </div>

                        <div className="verification-status-grid">
                            <div className={`verification-card ${migrationStatus.currentEmailVerified ? 'verified' : 'pending'}`}>
                                <div className="verification-card-header">
                                    <div className="verification-icon">
                                        {migrationStatus.currentEmailVerified ? (
                                            <CheckIcon size={24} />
                                        ) : (
                                            <MailIcon size={24} />
                                        )}
                                    </div>
                                    <h4>Current Email</h4>
                                </div>
                                <div className="verification-card-body">
                                    <p className="verification-email">{migrationStatus.currentEmail}</p>
                                    <div className="verification-status">
                                        {migrationStatus.currentEmailVerified ? (
                                            <span className="status-badge verified">✓ Verified</span>
                                        ) : (
                                            <span className="status-badge pending">⏳ Pending</span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className={`verification-card ${migrationStatus.newEmailVerified ? 'verified' : 'pending'}`}>
                                <div className="verification-card-header">
                                    <div className="verification-icon">
                                        {migrationStatus.newEmailVerified ? (
                                            <CheckIcon size={24} />
                                        ) : (
                                            <MailIcon size={24} />
                                        )}
                                    </div>
                                    <h4>New Email</h4>
                                </div>
                                <div className="verification-card-body">
                                    <p className="verification-email">{migrationStatus.newEmail}</p>
                                    <div className="verification-status">
                                        {migrationStatus.newEmailVerified ? (
                                            <span className="status-badge verified">✓ Verified</span>
                                        ) : (
                                            <span className="status-badge pending">⏳ Pending</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Success message will auto-redirect to history - no need to show here */}

                        {/* Migration History Button - only show if migration not complete */}
                        {!(migrationStatus.currentEmailVerified && migrationStatus.newEmailVerified) && (
                            <div style={{ marginTop: 'var(--spacing-6)', textAlign: 'center' }}>
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => {
                                        setShowHistory(true);
                                        // History will load automatically via useEffect when showHistory becomes true
                                    }}
                                >
                                    View Migration History
                                </button>
                            </div>
                        )}
                    </div>
                </AuthCard>
            </AuthLayout>
        );
    }

    // Initial form to start migration
    return (
        <AuthLayout>
            <AuthCard>
                <AuthHeader
                    title="Migrate Account"
                    subtitle="Change your email address and transfer your account data"
                />

                {status.error && <Alert type="error">{status.error}</Alert>}
                {status.success && <Alert type="success">{status.success}</Alert>}

                {emailExistsWarning?.exists && (
                    <div style={{
                        padding: 'var(--spacing-4)',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: 'var(--spacing-4)'
                    }}>
                        <h4 style={{ color: 'var(--color-error)', marginBottom: 'var(--spacing-2)' }}>
                            Warning: Account with New Email Already Exists!
                        </h4>
                        <p style={{ marginBottom: 'var(--spacing-2)' }}>
                            An account with the email <strong>{formData.newEmail}</strong> already exists.
                            Proceeding will permanently delete that account and all of its data.
                        </p>
                        <p style={{ marginBottom: 'var(--spacing-3)' }}>
                            Do you want to proceed and delete the existing account to migrate your current account to <strong>{formData.newEmail}</strong>?
                            This action cannot be undone.
                        </p>
                        <div style={{ display: 'flex', gap: 'var(--spacing-3)' }}>
                            <button
                                type="button"
                                className="btn btn-danger"
                                onClick={handleConfirmOverride}
                                disabled={status.loading}
                            >
                                {status.loading ? <Spinner size="sm" /> : 'Yes, Delete Existing Account & Migrate'}
                            </button>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                    setEmailExistsWarning(null);
                                    setStatus({ loading: false, error: '', success: '' });
                                }}
                                disabled={status.loading}
                            >
                                Cancel
                            </button>
                        </div>
                        <p style={{ marginTop: 'var(--spacing-3)', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                            Please review the warning above and confirm to proceed.
                        </p>
                    </div>
                )}

                <form onSubmit={(e) => handleSubmit(e, false)} className="migration-form-container">
                    <div className="migration-form-group">
                        <label htmlFor="password">
                            <LockIcon size={16} />
                            Password {user?.provider === 'local' ? '(required)' : '(not required for OAuth accounts)'}
                        </label>
                        <input
                            type="password"
                            id="password"
                            className="migration-input"
                            value={formData.password}
                            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                            placeholder={user?.provider === 'local' ? 'Enter your password' : 'Optional for OAuth accounts'}
                            required={user?.provider === 'local'}
                        />
                    </div>

                    <div className="migration-form-group">
                        <label htmlFor="newEmail">
                            <MailIcon size={16} />
                            New Email Address
                        </label>
                        <input
                            type="email"
                            id="newEmail"
                            className="migration-input"
                            value={formData.newEmail}
                            onChange={(e) => setFormData({ ...formData, newEmail: e.target.value.toLowerCase() })}
                            placeholder="Enter your new email address"
                            required
                        />
                    </div>

                    <button type="submit" className="btn btn-primary btn-full" disabled={status.loading}>
                        {status.loading ? (
                            <>
                                <Spinner size="sm" />
                                Initiating Migration...
                            </>
                        ) : (
                            'Start Migration'
                        )}
                    </button>
                </form>

                {/* Migration History Button */}
                <div style={{ marginTop: 'var(--spacing-4)', textAlign: 'center' }}>
                    <button
                        className="btn btn-secondary"
                        onClick={() => {
                            setShowHistory(true);
                            // History will load automatically via useEffect when showHistory becomes true
                        }}
                    >
                        View Migration History
                    </button>
                </div>
            </AuthCard>
        </AuthLayout>
    );
};
