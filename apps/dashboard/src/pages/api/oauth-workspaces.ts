import type { NextApiRequest, NextApiResponse } from 'next';

const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'https://api.deerdawn.com').replace(/\/+$/, '');

// The workspace listing, for the consent screen to name where a connection will
// be pinned. Same-origin passthrough of the caller's own bearer token to
// GET /api/v1/teams/workspaces (read-only, that person's memberships only), the
// way /api/oauth-approve forwards the approval.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'not_authenticated' });

  try {
    const apiRes = await fetch(`${API_URL}/api/v1/teams/workspaces`, {
      headers: { Accept: 'application/json', Authorization: authHeader },
    });
    const body = await apiRes.json().catch(() => ({}));
    return res.status(apiRes.status).json(body);
  } catch (err: any) {
    console.error('[OAUTH-WORKSPACES]', err?.message);
    return res.status(500).json({ error: 'internal_error' });
  }
}
