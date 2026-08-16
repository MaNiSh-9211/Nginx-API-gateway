import React from 'react';
import { Link } from 'react-router-dom';
import { ShieldIcon } from '../components/Icons';
import { AuthLayout } from '../components/AuthLayout';

export const HomePage: React.FC = () => {
    return (
        <AuthLayout>
            <div className="home-page fade-in">
                <div className="home-brand">
                    <div className="dashboard-brand-icon">
                        <ShieldIcon size={28} />
                    </div>
                    <h1>AuthAdvance</h1>
                </div>
                <p className="home-lead">
                    Secure account management behind your API gateway — sign in, manage your profile, or migrate your email.
                </p>
                <div className="home-actions">
                    <Link to="/login" className="btn btn-primary btn-lg">Sign in</Link>
                    <Link to="/register" className="btn btn-secondary btn-lg">Create account</Link>
                </div>
            </div>
        </AuthLayout>
    );
};
