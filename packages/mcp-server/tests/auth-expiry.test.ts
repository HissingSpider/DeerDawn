import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeerdawnClient } from '../src/client.js';
import { detectSurfaceState } from '../src/surface-state.js';
import { listTools } from '../src/tools/index.js';
import { credentialsWereRejected, markCredentialsRejected, resetCredentialState } from '../src/auth-state.js';

/**
 * "Is there a key on disk" was standing in for "is this session authenticated".
 *
 * The two questions come apart the moment a key expires, and when they did,
 * every recovery path closed at once: `authed` stayed true, so get_auth_status —
 * the tool carrying the sign-in link — was filtered out of tools/list for
 * exactly the session that needed it.
 */
describe('a credential the API has already refused', () => {
  const originalKey = process.env.DEERDAWN_API_KEY;

  beforeEach(() => resetCredentialState());
  afterEach(() => {
    resetCredentialState();
    if (originalKey === undefined) delete process.env.DEERDAWN_API_KEY;
    else process.env.DEERDAWN_API_KEY = originalKey;
  });

  it('stops counting as authentication, and brings the sign-in tool back', () => {
    process.env.DEERDAWN_API_KEY = 'dd_surface_state_probe';

    expect(detectSurfaceState(process.cwd()).authed).toBe(true);
    expect(listTools(detectSurfaceState(process.cwd())).map((t) => t.name)).not.toContain('get_auth_status');

    markCredentialsRejected();

    expect(detectSurfaceState(process.cwd()).authed).toBe(false);
    // The whole point: the tool that hands over the sign-in link is advertised
    // again, to the one session that cannot proceed without it.
    expect(listTools(detectSurfaceState(process.cwd())).map((t) => t.name)).toContain('get_auth_status');
  });

  it('overrides an env-var key, which expires exactly like a stored one', () => {
    process.env.DEERDAWN_API_KEY = 'dd_env_key_that_expired';
    markCredentialsRejected();
    expect(detectSurfaceState(process.cwd()).authed).toBe(false);
  });
});

/**
 * Driven over a real socket against a real 401, so this exercises the actual
 * axios interceptor rather than a re-description of it.
 */
describe('the client, on a real 401', () => {
  let server: http.Server;
  let url = '';

  beforeEach(async () => {
    resetCredentialState();
    server = http.createServer((req, res) => {
      // The cwd these cases steer by is a header now, not part of the URL.
      const where = `${req.url ?? ''} ${String(req.headers['x-deerdawn-cwd'] ?? '')}`;
      const status = where.includes('unauth') ? 401 : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(
        status === 401
          ? { error: 'unauthorized', message: 'API Key has expired.' }
          : { error: 'server_error' },
      ));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    resetCredentialState();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const client = (apiUrl: string) => new DeerdawnClient({
    apiUrl,
    apiKey: 'local-dev-key',
    environment: 'sandbox',
    cacheEnabled: false,
    cacheTtlSeconds: 60,
    // Zero retries: a 401 must not be retried, and this keeps the 500 case fast.
    maxRetries: 0,
    retryBackoffMs: 100,
  } as any);

  it('records the rejection where every response already passes', async () => {
    expect(credentialsWereRejected()).toBe(false);

    await expect(client(url).getContextMap(true, '/unauth')).rejects.toBeTruthy();

    expect(credentialsWereRejected()).toBe(true);
  });

  it('does not treat a server error as a rejected credential', async () => {
    await expect(client(url).getContextMap(true, '/boom')).rejects.toBeTruthy();

    // A 500 is the service's problem, not the key's. Conflating them would put
    // the session back on the wrong remedy from the opposite direction.
    expect(credentialsWereRejected()).toBe(false);
  });
});
