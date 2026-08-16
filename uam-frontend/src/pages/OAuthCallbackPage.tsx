import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';
import { Spinner } from '../components/FormElements';
import { AuthLayout, AuthCard } from '../components/AuthLayout';
import { OAUTH_STATE_KEY, OAUTH_VERIFIER_KEY } from '../utils/pkce';

const OAUTH_ERRORS = new Set(['oauth_failed', 'access_denied', 'provider_conflict']);

export const OAuthCallbackPage: React.FC = () => {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { setUserFromOAuth } = useAuth();
    const exchangeStarted = useRef(false);

    useEffect(() => {
        const handleCallback = async () => {
            if (exchangeStarted.current) {
                return;
            }

            const error = searchParams.get('error');
            if (error) {
                const safeError = OAUTH_ERRORS.has(error) ? error : 'oauth_failed';
                navigate(`/login?error=${encodeURIComponent(safeError)}`, { replace: true });
                return;
            }

            const code = searchParams.get('code');
            const state = searchParams.get('state');
            const codeVerifier = sessionStorage.getItem(OAUTH_VERIFIER_KEY);
            const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);

            if (!code || !state || !codeVerifier || state !== expectedState) {
                navigate('/login?error=oauth_failed', { replace: true });
                return;
            }

            exchangeStarted.current = true;
            sessionStorage.removeItem(OAUTH_VERIFIER_KEY);
            sessionStorage.removeItem(OAUTH_STATE_KEY);
            window.history.replaceState({}, '', '/oauth-callback');

            try {
                const response = await api.exchangeOAuthCode(code, state, codeVerifier);
                if (response.accessToken) {
                    await setUserFromOAuth(response.accessToken, '');
                    navigate('/dashboard', { replace: true });
                    return;
                }
            } catch {
                navigate('/login?error=oauth_failed', { replace: true });
                return;
            }

            navigate('/login?error=oauth_failed', { replace: true });
        };

        void handleCallback();
    }, [searchParams, navigate, setUserFromOAuth]);

    return (
        <AuthLayout>
            <AuthCard>
                <div className="text-center">
                    <Spinner size="lg" />
                    <p style={{ marginTop: 'var(--spacing-4)' }}>Completing authentication...</p>
                </div>
            </AuthCard>
        </AuthLayout>
    );
};
