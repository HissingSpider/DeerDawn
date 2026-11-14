import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDeviceFlow } from '../src/auth.js';

/**
 * What the device-flow poll does with an answer it cannot make progress on.
 *
 * Two mistakes, both of which cost the user the whole window:
 *
 *  1. /token answers 404 for a code that has expired or has already been
 *     collected (apps/api/src/routes/shared/mcp-auth.js). That fell into
 *     `if (!res.ok) continue`, so the client kept asking a dead code for up to
 *     thirty minutes and then said "Authorization timed out" — a description of
 *     waiting, about an expiry that had already happened before the first poll.
 *
 *  2. A 429 backed off up to TWO MINUTES at a time, and did so blind: with no
 *     Retry-After header it multiplied the poll interval by five, and it ignored
 *     RateLimit-Reset entirely. On a link with a short life that is the whole
 *     life, spent not asking, while the browser tab already says Authorized.
 */
describe('the device-flow poll', () => {
  let dir: string;
  let server: http.Server;
  let apiUrl: string;
  let tokenPolls = 0;
  let respond: (res: http.ServerResponse, polls: number) => void;
  let startBody: Record<string, unknown>;
  const original = {
    deerdawnDir: process.env.DEERDAWN_DIR,
    homeDir: process.env.DEERDAWN_HOME_DIR,
    home: process.env.HOME,
  };

  beforeEach(async () => {
    tokenPolls = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-poll-'));
    process.env.DEERDAWN_HOME_DIR = dir;
    process.env.DEERDAWN_DIR = path.join(dir, '.deerdawn');
    // saveApiKey runs autoConfigureHooks, which writes under os.homedir().
    // Point that at the temp directory so a test can never touch the real one.
    process.env.HOME = dir;
    fs.mkdirSync(process.env.DEERDAWN_DIR, { recursive: true });

    startBody = {
      device_code: 'dc_terminal',
      user_code: 'DEAD0001',
      verification_url: 'https://app.deerdawn.test/mcp-auth?code=DEAD0001',
      expires_in: 5,
      interval: 0.5,
    };
    respond = (res) => res.end(JSON.stringify({ status: 'pending' }));

    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/api/v1/auth/mcp/start')) {
        req.resume();
        res.end(JSON.stringify(startBody));
        return;
      }
      if (req.url?.startsWith('/api/v1/auth/mcp/token')) {
        tokenPolls += 1;
        respond(res, tokenPolls);
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of [
      ['DEERDAWN_DIR', original.deerdawnDir],
      ['DEERDAWN_HOME_DIR', original.homeDir],
      ['HOME', original.home],
    ] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops on the first 404 and says the link is dead, instead of asking a spent code all window', async () => {
    respond = (res) => { res.statusCode = 404; res.end(JSON.stringify({ error: 'expired_or_invalid' })); };

    await expect(runDeviceFlow(apiUrl)).rejects.toThrow(/expired or has already been used/i);
    // One question asked, one final answer believed. Anything more is the old
    // behaviour polling a code the API has already told it is gone.
    expect(tokenPolls).toBe(1);
    // And the saved link is not left behind to be handed out again as if live.
    expect(fs.existsSync(path.join(process.env.DEERDAWN_DIR!, 'pending-auth.json'))).toBe(false);
  }, 20_000);

  it('honours RateLimit-Reset, so a rate limit costs seconds rather than the link', async () => {
    // Twice limited, then authorized. The server states a one-second window; the
    // old code ignored RateLimit-Reset, slept five times the poll interval on
    // each 429, and ran the five-second link out before asking a third time.
    respond = (res, polls) => {
      if (polls <= 2) {
        res.statusCode = 429;
        res.setHeader('RateLimit-Reset', '1');
        res.end(JSON.stringify({ error: 'rate_limited' }));
        return;
      }
      res.end(JSON.stringify({ status: 'authorized', api_key: 'dd_after_the_limit' }));
    };

    await expect(runDeviceFlow(apiUrl)).resolves.toMatchObject({ apiKey: 'dd_after_the_limit' });
    expect(tokenPolls).toBe(3);
  }, 20_000);

  it('refuses to sleep past the code it is waiting on, and says why', async () => {
    // Retry-After far longer than this link lives. The old rule clamped to two
    // minutes, then to whatever was left of the window, and reported the result
    // as "Authorization timed out" — which names neither the rate limit nor the
    // one thing that helps.
    respond = (res) => {
      res.statusCode = 429;
      res.setHeader('Retry-After', '300');
      res.end(JSON.stringify({ error: 'rate_limited' }));
    };

    await expect(runDeviceFlow(apiUrl)).rejects.toThrow(/rate limited .* than this link lives/i);
    await expect(runDeviceFlow(apiUrl)).rejects.toThrow(/start sign-in again for a fresh link/i);
  }, 20_000);
});
