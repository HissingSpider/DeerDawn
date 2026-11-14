import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPendingAuthFresh, loadPendingAuth, savePendingAuth, PENDING_AUTH_TTL_MS } from '../src/auth.js';

/**
 * A saved sign-in link outlives the code inside it.
 *
 * The API's device code lives ten minutes. `clearPendingAuth()` runs only on a
 * SUCCESSFUL sign-in, and get_auth_status minted a fresh code only when
 * pending-auth.json was absent entirely — so an abandoned attempt left the file
 * behind forever and every later auth failure served the same expired URL. The
 * dashboard answered 404, and re-running sign-in produced the identical link:
 * a dead end with no exit.
 *
 * Observed 2026-09-06 on a pending-auth.json written 31 hours earlier, whose
 * code had expired 10 minutes after it was written.
 *
 * Three places asked "is this link still good" and gave three different answers.
 * These pin the one that is now shared.
 */
describe('a saved sign-in link', () => {
  let dir: string;
  const originalDir = process.env.DEERDAWN_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-pending-'));
    process.env.DEERDAWN_DIR = dir;
  });

  afterEach(() => {
    if (originalDir === undefined) delete process.env.DEERDAWN_DIR;
    else process.env.DEERDAWN_DIR = originalDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is fresh the moment it is written', () => {
    savePendingAuth({ verification_url: 'https://app.deerdawn.com/mcp-auth?code=ABCD1234', device_code: 'dc' });
    expect(isPendingAuthFresh(loadPendingAuth())).toBe(true);
  });

  // The reported failure, to the minute.
  it('is not fresh 31 hours later, however good it looks', () => {
    const thirtyOneHoursAgo = new Date(Date.now() - 31 * 60 * 60 * 1000).toISOString();
    expect(isPendingAuthFresh({ started_at: thirtyOneHoursAgo })).toBe(false);
  });

  it('goes stale exactly at the device code lifetime', () => {
    const justInside = new Date(Date.now() - (PENDING_AUTH_TTL_MS - 5_000)).toISOString();
    const justOutside = new Date(Date.now() - (PENDING_AUTH_TTL_MS + 5_000)).toISOString();
    expect(isPendingAuthFresh({ started_at: justInside })).toBe(true);
    expect(isPendingAuthFresh({ started_at: justOutside })).toBe(false);
  });

  // The API now sends expires_at; when it is present it is the authority, since
  // it knows the real TTL rather than inferring it from age.
  it('believes an explicit expiry over the clock', () => {
    const longAgo = new Date(Date.now() - 31 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(isPendingAuthFresh({ started_at: longAgo, expires_at: future })).toBe(true);
    expect(isPendingAuthFresh({ started_at: new Date().toISOString(), expires_at: past })).toBe(false);
  });

  // A file with no timestamp at all cannot be vouched for, and the safe reading
  // is "stale" — that costs one extra device-flow start, where the other
  // direction costs the user another dead link.
  it('is not fresh when it carries no timestamp, and never crashes on junk', () => {
    expect(isPendingAuthFresh({})).toBe(false);
    expect(isPendingAuthFresh(null)).toBe(false);
    expect(isPendingAuthFresh({ started_at: 'not a date' })).toBe(false);
  });
});
