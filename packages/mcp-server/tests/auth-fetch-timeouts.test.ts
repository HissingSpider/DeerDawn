import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { beginDeviceFlow } from '../src/auth.js';
import { checkApiKeyDetailed } from '../src/tools/auth.js';

/**
 * An API that accepts the connection and never answers.
 *
 * This is not the failure `fetch` reports. Without a signal the request simply
 * never settles: the promise stays pending, and so does whatever is awaiting it.
 * Every other network caller in the package carries a deadline (the axios client,
 * the flush, the session-context hook); the auth path did not, so a half-open
 * socket could hang get_auth_status — the one tool a stuck session is told to
 * reach for — for the life of the process, with nothing on screen.
 *
 * Both calls are made at once so the test costs one timeout, not two.
 */
describe('the auth path against a server that never answers', () => {
  let dir: string;
  let server: http.Server;
  let apiUrl: string;
  const sockets: net.Socket[] = [];
  const original = { deerdawnDir: process.env.DEERDAWN_DIR, homeDir: process.env.DEERDAWN_HOME_DIR };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-hang-'));
    process.env.DEERDAWN_HOME_DIR = dir;
    process.env.DEERDAWN_DIR = path.join(dir, '.deerdawn');
    fs.mkdirSync(process.env.DEERDAWN_DIR, { recursive: true });

    // Accept, read the request, and then say nothing at all. No response, no
    // close: exactly the shape a wedged upstream or a dropped NAT mapping has.
    server = http.createServer((req) => { req.resume(); });
    server.on('connection', (socket) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (original.deerdawnDir === undefined) delete process.env.DEERDAWN_DIR; else process.env.DEERDAWN_DIR = original.deerdawnDir;
    if (original.homeDir === undefined) delete process.env.DEERDAWN_HOME_DIR; else process.env.DEERDAWN_HOME_DIR = original.homeDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives up rather than hanging the tool call forever', async () => {
    const [keyCheck, deviceStart] = await Promise.all([
      checkApiKeyDetailed(apiUrl, 'dd_some_key'),
      beginDeviceFlow(apiUrl).then(() => 'resolved' as const, (err) => err as Error),
    ]);

    // A timeout is indistinguishable from an unreachable API from here, and
    // "unreachable" is the honest answer with usable advice already attached.
    expect(keyCheck.state).toBe('unreachable');
    // The sign-in start surfaces its failure instead of never returning.
    expect(deviceStart).toBeInstanceOf(Error);
    // And it surfaces it in words somebody can act on. An abort is reported by
    // the runtime as "This operation was aborted" — its description of its own
    // mechanism, naming no service, no deadline, and nothing to do. That string
    // travelled out verbatim to `setup` ("Sign-in could not be completed: This
    // operation was aborted"), and get_auth_status relayed the same.
    const message = (deviceStart as Error).message;
    expect(message).not.toMatch(/operation was aborted/i);
    expect(message).toMatch(/DeerDawn API did not answer within 10 seconds/i);
    expect(message).toMatch(/check your connection/i);
  }, 30_000);
});
