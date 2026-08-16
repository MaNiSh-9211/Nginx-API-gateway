import React from 'react';
import { ShieldIcon } from './Icons';

interface AuthVisualSideProps {
    title: string;
    description: string;
    features?: string[];
}

export const AuthVisualSide: React.FC<AuthVisualSideProps> = ({
    title,
    description,
    features = [],
}) => {
    return (
        <div className="auth-visual-content">
            <div className="auth-visual-logo">
                <div className="auth-visual-logo-glow"></div>
                <ShieldIcon />
            </div>
            <h2 className="auth-visual-title">{title}</h2>
            <p className="auth-visual-description">{description}</p>
            {features.length > 0 && (
                <ul className="auth-visual-features">
                    {features.map((feature, index) => (
                        <li key={index} className="auth-visual-feature">
                            <span className="auth-visual-feature-icon">✓</span>
                            <span>{feature}</span>
                        </li>
                    ))}
                </ul>
            )}
            <div className="auth-visual-decoration">
                <div className="floating-shape shape-1"></div>
                <div className="floating-shape shape-2"></div>
                <div className="floating-shape shape-3"></div>
            </div>
        </div>
    );
};

