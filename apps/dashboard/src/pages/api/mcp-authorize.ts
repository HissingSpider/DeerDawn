import type { NextApiRequest, NextApiResponse } from 'next';

const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'https://api.deerdawn.com').replace(/\/+$/, '');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'not_authenticated', message: 'Sign in to app.deerdawn.com first, then open this link again.' });

  const { user_code } = req.body;
  if (!user_code) return res.status(400).json({ error: 'missing_user_code' });

  try {
    const apiRes = await fetch(`${API_URL}/api/v1/auth/mcp/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ user_code }),
    });

    const body = await apiRes.json().catch(() => ({}));
    return res.status(apiRes.status).json(body);
  } catch (err: any) {
    console.error('[MCP-AUTHORIZE]', err?.message);
    return res.status(500).json({ error: 'internal_error', message: err?.message });
  }
}
