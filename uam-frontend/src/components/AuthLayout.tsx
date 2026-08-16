import React from 'react';
import { ShieldIcon } from './Icons';
import { AnimatedBackground } from './AnimatedBackground';

interface AuthLayoutProps {
    children: React.ReactNode;
    visualSide?: React.ReactNode;
}

export const AuthLayout: React.FC<AuthLayoutProps> = ({ children, visualSide }) => (
    <div className="auth-layout">
        <AnimatedBackground />
        <div className="auth-layout-container">
            {visualSide && <div className="auth-visual-side">{visualSide}</div>}
            <div className="auth-container">{children}</div>
        </div>
    </div>
);

interface AuthCardProps {
    children: React.ReactNode;
}

export const AuthCard: React.FC<AuthCardProps> = ({ children }) => (
    <div className="auth-card fade-in">{children}</div>
);

interface AuthHeaderProps {
    title: string;
    subtitle?: string;
}

export const AuthHeader: React.FC<AuthHeaderProps> = ({ title, subtitle }) => (
    <div className="auth-header">
        <div className="auth-logo">
            <div className="auth-logo-glow"></div>
            <ShieldIcon />
        </div>
        <h1 className="auth-title">{title}</h1>
        {subtitle && <p className="auth-subtitle">{subtitle}</p>}
    </div>
);

interface AuthFooterProps {
    children: React.ReactNode;
}

export const AuthFooter: React.FC<AuthFooterProps> = ({ children }) => (
    <div className="auth-footer">{children}</div>
);
