import React from 'react';
import { XIcon } from './Icons';

interface InputFieldProps {
    label: string;
    name: string;
    type?: string;
    placeholder?: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    error?: string;
    icon?: React.ReactNode;
    status?: 'idle' | 'checking' | 'success' | 'error';
    statusIcon?: React.ReactNode;
    successMessage?: string;
}

export const InputField: React.FC<InputFieldProps> = ({
    label,
    name,
    type = 'text',
    placeholder,
    value,
    onChange,
    error,
    icon,
    status = 'idle',
    statusIcon,
    successMessage,
}) => {
    const getInputClass = () => {
        let cls = 'form-input';
        if (error || status === 'error') cls += ' error';
        if (status === 'success') cls += ' success';
        return cls;
    };

    return (
        <div className="form-group">
            <label className="form-label">{label}</label>
            <div className="input-wrapper">
                {icon && <span className="input-icon">{icon}</span>}
                <input
                    type={type}
                    name={name}
                    className={getInputClass()}
                    placeholder={placeholder}
                    value={value}
                    onChange={onChange}
                />
                {statusIcon && <span className="input-status">{statusIcon}</span>}
            </div>
            {error && (
                <span className="form-error">
                    <XIcon /> {error}
                </span>
            )}
            {!error && successMessage && status === 'success' && (
                <span className="form-success">{successMessage}</span>
            )}
        </div>
    );
};

// Password Strength Indicator
interface PasswordStrengthProps {
    password: string;
}

export const PasswordStrength: React.FC<PasswordStrengthProps> = ({ password }) => {
    const getStrength = (): number => {
        let strength = 0;
        if (password.length >= 8) strength++;
        if (/[A-Z]/.test(password) && /[a-z]/.test(password)) strength++;
        if (/[0-9]/.test(password)) strength++;
        if (/[^A-Za-z0-9]/.test(password)) strength++;
        return strength;
    };

    const strength = getStrength();

    if (!password) return null;

    return (
        <div className="password-strength">
            {[1, 2, 3, 4].map((level) => (
                <div
                    key={level}
                    className={`password-strength-bar ${level <= strength ? 'active' : ''} ${strength >= 3 ? 'strong' : strength >= 2 ? 'medium' : ''
                        }`}
                />
            ))}
        </div>
    );
};

// Loading Spinner
interface SpinnerProps {
    size?: 'sm' | 'md' | 'lg';
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 'md' }) => {
    const sizeClass = size === 'sm' ? 'spinner-sm' : '';
    const style = size === 'lg' ? { width: 40, height: 40 } : undefined;
    return <div className={`spinner ${sizeClass}`} style={style} />;
};

// Alert Component
interface AlertProps {
    type: 'error' | 'success';
    children: React.ReactNode;
}

export const Alert: React.FC<AlertProps> = ({ type, children }) => (
    <div className={`alert alert-${type}`} style={{ marginBottom: 'var(--spacing-5)' }}>
        <span className="alert-icon">
            <XIcon />
        </span>
        <div className="alert-content">{children}</div>
    </div>
);

// Info Alert Component for detailed instructions
interface InfoAlertProps {
    title: string;
    children: React.ReactNode;
}

export const InfoAlert: React.FC<InfoAlertProps> = ({ title, children }) => (
    <div className="alert alert-info" style={{
        marginBottom: 'var(--spacing-5)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 'var(--spacing-2)',
        padding: 'var(--spacing-4)',
        borderLeft: '4px solid var(--color-primary)',
        background: 'rgba(var(--color-primary-rgb), 0.1)'
    }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-2)', fontWeight: '600', color: 'var(--color-primary)' }}>
            <span style={{ fontSize: '1.2rem' }}>ℹ️</span>
            <span>{title}</span>
        </div>
        <div style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)', lineHeight: '1.5' }}>
            {children}
        </div>
    </div>
);
