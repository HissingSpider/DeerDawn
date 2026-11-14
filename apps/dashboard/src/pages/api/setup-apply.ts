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
  if (req.method !== 'POST') return res.status(405).end();
  const actor = await requireDashboardApiAuth(req, res);
  if (!actor) return;

  const surface = typeof req.body?.surface === 'string' ? req.body.surface : '';
  const mode = req.body?.mode === 'repair' || req.body?.mode === 'restore' ? req.body.mode : 'auto';
  if (!surface) return res.status(400).json({ error: 'invalid_payload', message: 'surface is required' });

  try {
    return res.status(501).json({
      result: {
        surface,
        mode,
        applied: false,
        execution_source: 'unavailable',
        status: unavailableStatus,
        changed_paths: [],
        restored_from_backup: null,
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'setup_apply_failed', message: err?.message || 'Failed to apply DeerDawn setup.' });
  }
}
