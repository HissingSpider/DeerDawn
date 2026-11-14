/**
 * One session hook for the two authorize screens (/mcp-auth, /oauth/consent),
 * whichever way this dashboard signs people in.
 *
 * Under Clerk they read Clerk's `useAuth()` and send a bearer token to their
 * same-origin proxies (pages/api/mcp-authorize, oauth-approve, oauth-workspaces).
 * Without Clerk — local dev and every self-hosted install — there is no
 * ClerkProvider, `useAuth()` throws, and the session is the API's own dd_session
 * cookie, which a bearer header cannot carry. These pages used to answer
 * "sign-in unavailable" there, so a self-host could not approve a CLI sign-in or
 * a claude.ai / ChatGPT connector at all.
 *
 * The implementation is chosen once, at module load, from the same build-time
 * gate _app.tsx uses (lib/authMode), so a component never switches hooks
 * between renders.
 */
import { useAuth } from '@clerk/nextjs';
import { useCallback, useEffect, useState } from 'react';
import { isClerkHostedAuthEnabled } from '@/lib/authMode';
import { api, getApiBaseUrl } from '@/lib/api';

/**
 * Stands in for a bearer token when the session is the API cookie. Never sent
 * anywhere: authorizedFetch recognises it and calls the API with the cookie.
 */
export const COOKIE_SESSION = 'cookie-session';

type DashboardAuth = {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  getToken: () => Promise<string | null>;
};

function useCredentialAuth(): DashboardAuth {
  const [state, setState] = useState<{ isLoaded: boolean; isSignedIn: boolean | undefined }>({ isLoaded: false, isSignedIn: undefined });
  useEffect(() => {
    let cancelled = false;
    api.getCurrentUser()
      .then(() => { if (!cancelled) setState({ isLoaded: true, isSignedIn: true }); })
      .catch(() => { if (!cancelled) setState({ isLoaded: true, isSignedIn: false }); });
    return () => { cancelled = true; };
  }, []);
  const getToken = useCallback(async () => (state.isSignedIn ? COOKIE_SESSION : null), [state.isSignedIn]);
  return { ...state, getToken };
}

function useClerkDashboardAuth(): DashboardAuth {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  return { isLoaded, isSignedIn, getToken };
}

export const useDashboardAuth: () => DashboardAuth = isClerkHostedAuthEnabled()
  ? useClerkDashboardAuth
  : useCredentialAuth;

function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|; )dd_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Call an authenticated endpoint the authorize screens need.
 *
 *   Clerk token:       the same-origin proxy (`proxyPath`), bearer attached,
 *                      exactly as before.
 *   Cookie session:    the API itself (`apiPath`), with the session cookie and
 *                      the CSRF header the API requires on a cookie-authed write.
 */
export function authorizedFetch(
  token: string,
  proxyPath: string,
  apiPath: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  if (token !== COOKIE_SESSION) {
    return fetch(proxyPath, {
      method: init.method || 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(init.body ? { body: init.body } : {}),
    });
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    const csrf = csrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  return fetch(`${getApiBaseUrl()}${apiPath}`, {
    method,
    headers,
    credentials: 'include',
    ...(init.body ? { body: init.body } : {}),
  });
}
