import type { NextApiRequest, NextApiResponse } from 'next';
import { requireDashboardApiAuth } from './_auth';

const unavailableStatus = {
  authenticated: false,
  setup_complete: false,
  configured_count: 0,
  verified_count: 0,
  pending_sign_in_url: null,
  execution_source: 'unavailable' as const,
  surfaces: [],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  const actor = await requireDashboardApiAuth(req, res, { requireCsrf: false });
  if (!actor) return;

  try {
    return res.status(200).json({ status: unavailableStatus });
  } catch (err: any) {
    return res.status(500).json({ error: 'setup_status_failed', message: err?.message || 'Failed to inspect local setup status.' });
  }
}
