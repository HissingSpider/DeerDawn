import crypto from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getAuth } from '@clerk/nextjs/server';

type DashboardActor = {
  user_id: string;
  org_id: string;
};

function getCookie(req: NextApiRequest, name: string): string | null {
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((pair) => {
      const [rawKey, ...rawValue] = pair.trim().split('=');
      return [rawKey, decodeURIComponent(rawValue.join('='))];
    }).filter(([key]) => key)
  );
  return typeof cookies[name] === 'string' ? cookies[name] : null;
}

function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export async function requireDashboardApiAuth(
  req: NextApiRequest,
  res: NextApiResponse,
  options: { requireCsrf?: boolean } = {}
) {
  const method = req.method?.toUpperCase() || 'GET';
  const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  if (options.requireCsrf !== false && isMutating) {
    const csrfHeader = typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
    const csrfCookie = getCookie(req, 'dd_csrf') || '';
    if (!csrfHeader || !csrfCookie || !secureCompare(csrfHeader, csrfCookie)) {
      res.status(403).json({ error: 'forbidden', message: 'Invalid CSRF token.' });
      return null;
    }
  }

  let clerkAuth: ReturnType<typeof getAuth> | null = null;
  try {
    clerkAuth = getAuth(req);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[dashboard-api-auth] Clerk request auth unavailable:', err instanceof Error ? err.message : err);
    }
  }

  if (clerkAuth?.userId) {
    return {
      user_id: clerkAuth.userId,
      org_id: clerkAuth.orgId || 'org-dashboard',
    } satisfies DashboardActor;
  }

  // M4 fix: previously, when Clerk didn't resolve a session, any request that
  // merely PRESENTED an `Authorization: Bearer <anything>` header or a
  // `dd_session` cookie was granted a synthetic actor — no signature check, no
  // session lookup against any backend. That's `Authorization: Bearer anything`
  // getting an identity. There is no backend endpoint in this repo that
  // verifies a `dd_session` token, so there is nothing to trust it against;
  // require a real, Clerk-verified session instead of inventing a fallback.
  res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
  return null;
}
