import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { beginDeviceFlow, loadSavedApiKey } from '../src/auth.js';
import {
  announceCredentialRenewed,
  credentialsWereRejected,
  markCredentialsRejected,
  resetCredentialState,
  setCredentialRenewalListener,
} from '../src/auth-state.js';

/**
 * A sign-in has to actually land somewhere.
 *
 * Observed 2026-09-06: the user completed the browser sign-in correctly, three
 * times, and nothing happened. Two mechanisms had to fail together:
 *
 *  1. index.ts starts a device flow — the only thing that polls /token — ONLY
 *     when no credentials.json exists. A dead key is still a key, so an install
 *     whose key had expired took the "just use it" branch forever.
 *  2. beginDeviceFlow, reached through get_auth_status, returned a URL and
 *     nothing else. So every link handed out was addressed to a listener that
 *     did not exist, and the minted credential sat server-side unclaimed until
 *     its TTL wiped it.
 *
 * And even once claimed, the key is baked into an axios instance at
 * construction — so it would not have taken effect until a restart that nobody
 * was ever told to perform.
 *
 * Every existing test started from NO credentials, which is the state that
 * works. These start from the state users are actually in.
 */
describe('a sign-in started from a stale credential', () => {
  let dir: string;
  let server: http.Server;
  let apiUrl: string;
  let tokenPolls = 0;
  const originalDir = process.env.DEERDAWN_DIR;
  const originalHome = process.env.DEERDAWN_HOME_DIR;

  beforeEach(async () => {
    resetCredentialState();
    tokenPolls = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-signin-'));
    process.env.DEERDAWN_HOME_DIR = dir;
    process.env.DEERDAWN_DIR = path.join(dir, '.deerdawn');
    fs.mkdirSync(process.env.DEERDAWN_DIR, { recursive: true });

    // The state that broke everything: a key on disk that no longer works.
    fs.writeFileSync(
      path.join(process.env.DEERDAWN_DIR, 'credentials.json'),
      JSON.stringify({ api_key: 'dd_expired_key_from_june' }),
    );

    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/v1/auth/mcp/start')) {
        res.end(JSON.stringify({
          device_code: 'dc_test',
          user_code: 'ABCD1234',
          verification_url: 'https://app.deerdawn.test/mcp-auth?code=ABCD1234',
          expires_in: 4,
          expires_at: new Date(Date.now() + 4000).toISOString(),
          interval: 1,
        }));
        return;
      }
      if (req.url?.startsWith('/api/v1/auth/mcp/token')) {
        tokenPolls += 1;
        // The human takes a moment, exactly as they do in a browser.
        if (tokenPolls < 2) { res.end(JSON.stringify({ status: 'pending' })); return; }
        res.end(JSON.stringify({ status: 'authorized', api_key: 'dd_freshly_minted_key' }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    resetCredentialState();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalDir === undefined) delete process.env.DEERDAWN_DIR; else process.env.DEERDAWN_DIR = originalDir;
    if (originalHome === undefined) delete process.env.DEERDAWN_HOME_DIR; else process.env.DEERDAWN_HOME_DIR = originalHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is listened for, so the key it produces reaches disk without a restart', async () => {
    markCredentialsRejected();
    const adopted: string[] = [];
    setCredentialRenewalListener((key) => adopted.push(key));

    const url = await beginDeviceFlow(apiUrl);
    expect(url).toContain('ABCD1234');

    // The whole point: handing out the link started something that waits for it.
    await new Promise((r) => setTimeout(r, 2500));

    expect(tokenPolls).toBeGreaterThan(1);
    expect(loadSavedApiKey()).toBe('dd_freshly_minted_key');
    // Reaches the LIVE client, not just the file.
    expect(adopted).toEqual(['dd_freshly_minted_key']);
    // And the session stops believing it is signed out.
    expect(credentialsWereRejected()).toBe(false);
    // The pending link is spent, so it cannot be served again as if it were live.
    expect(fs.existsSync(path.join(process.env.DEERDAWN_DIR!, 'pending-auth.json'))).toBe(false);
  });

  it('clears the rejection latch when a credential is renewed', () => {
    markCredentialsRejected();
    expect(credentialsWereRejected()).toBe(true);
    announceCredentialRenewed('dd_new');
    expect(credentialsWereRejected()).toBe(false);
  });

  it('survives a listener that throws — a sign-in must not fail on a subscriber', () => {
    markCredentialsRejected();
    setCredentialRenewalListener(() => { throw new Error('client blew up'); });
    expect(() => announceCredentialRenewed('dd_new')).not.toThrow();
    expect(credentialsWereRejected()).toBe(false);
  });
});
