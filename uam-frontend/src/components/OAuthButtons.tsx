import React, { useEffect, useState } from 'react';
import { GoogleIcon, GithubIcon } from './Icons';
import { api } from '../api/client';

interface OAuthButtonsProps {
    className?: string;
    onOAuthError?: (message: string) => void;
}

export const OAuthButtons: React.FC<OAuthButtonsProps> = ({ className, onOAuthError }) => {
    const [providers, setProviders] = useState<{ google: boolean; github: boolean }>({
        google: false,
        github: false,
    });
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        void api
            .getOAuthProviders()
            .then((p) => {
                setProviders(p);
                setLoaded(true);
            })
            .catch(() => {
                setProviders({ google: false, github: false });
                setLoaded(true);
            });
    }, []);

    const notConfiguredMsg =
        'OAuth is not configured yet. Add GOOGLE_CLIENT_ID / GITHUB_CLIENT_ID to dev/.env.dev and restart uam-backend.';

    const startGoogle = async () => {
        if (!providers.google) {
            onOAuthError?.(notConfiguredMsg);
            return;
        }
        await api.startOAuth('google', { prompt: 'select_account' });
    };

    const startGithub = async () => {
        if (!providers.github) {
            onOAuthError?.(notConfiguredMsg);
            return;
        }
        await api.startOAuth('github');
    };

    const showSetupHint = loaded && !providers.google && !providers.github;

    return (
        <>
            <Divider />
            {showSetupHint && (
                <p className="text-sm text-muted" style={{ marginBottom: 'var(--spacing-4)', textAlign: 'center' }}>
                    Google / GitHub sign-in needs OAuth credentials in <code>dev/.env.dev</code>
                </p>
            )}
            <div className={`flex flex-col gap-4 ${className || ''}`}>
                <button
                    type="button"
                    onClick={() => void startGoogle()}
                    className="oauth-btn"
                    aria-disabled={!providers.google}
                    style={!providers.google ? { opacity: 0.85 } : undefined}
                >
                    <GoogleIcon />
                    <span>Continue with Google</span>
                </button>
                <button
                    type="button"
                    onClick={() => void startGithub()}
                    className="oauth-btn"
                    aria-disabled={!providers.github}
                    style={!providers.github ? { opacity: 0.85 } : undefined}
                >
                    <GithubIcon />
                    <span>Continue with GitHub</span>
                </button>
            </div>
        </>
    );
};

export const Divider: React.FC<{ text?: string }> = ({ text = 'or continue with' }) => (
    <div className="divider" style={{ margin: 'var(--spacing-6) 0' }}>
        {text}
    </div>
);
