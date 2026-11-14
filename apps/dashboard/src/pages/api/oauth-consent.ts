import type { NextApiRequest, NextApiResponse } from 'next';

const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'https://api.deerdawn.com').replace(/\/+$/, '');

// Non-secret display details for the pending authorization request, so the
// consent screen can show the resource owner which client is asking and where
// their authorization code will be delivered. No auth is required: the response
// exposes only fields the client itself chose (name + redirect_uri) and never a
// credential. Purely a same-origin passthrough to the API.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const requestId = typeof req.query.req === 'string' ? req.query.req : '';
  if (!/^[a-f0-9]{48}$/.test(requestId)) {
    return res.status(400).json({ error: 'invalid_request', message: 'missing or malformed req' });
  }

  try {
    const apiRes = await fetch(`${API_URL}/api/v1/oauth/consent/${requestId}`, {
      headers: { Accept: 'application/json' },
    });
    const body = await apiRes.json().catch(() => ({}));
    return res.status(apiRes.status).json(body);
  } catch (err: any) {
    console.error('[OAUTH-CONSENT]', err?.message);
    return res.status(500).json({ error: 'internal_error', message: err?.message });
  }
}
