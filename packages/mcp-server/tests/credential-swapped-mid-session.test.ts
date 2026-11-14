/**
 * The 401 retry adopted whatever key credentials.json now held, and said
 * nothing.
 *
 * That is right in the case it was built for — two editor windows, one HOME,
 * the saved key expires, the other window signs in again — and wrong in a case
 * that writes the same file: somebody ELSE signing in on a shared machine. The
 * session then continued under their credential, filing this conversation as
 * their memory and following project ids resolved for the previous account,
 * with nothing in the answer to say anything had changed.
 *
 * Which of the two happened cannot be established from here. The validation the
 * client already makes (POST /api/v1/context/search) answers `{ results }` and
 * carries no account identity; a key id is `dd_<8 random hex>` minted per KEY,
 * so a renewal by the same person has a brand new prefix and is byte-for-byte
 * as different as a stranger's. So the recovery stays — refusing it would
 * restore the loop it ended — and the two things that are unsafe under EITHER
 * reading are undone: the answer says what happened, once, and in-process
 * project targeting is dropped rather than reused under a new credential.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleToolCall } from '../src/tools/index.js';
import { consumeCredentialSwapNotice, liveCredential, noteLiveCredential, resetCredentialState, setCredentialRenewalListener } from '../src/auth-state.js';
import { rememberWriteTarget, forgetWriteTargets, resolveWriteTarget } from '../src/write-target.js';
import { AxiosError } from 'axios';

const SESSION_KEY = 'dd_aaaaaaaa_' + 'a'.repeat(64);
const SOMEONE_ELSES_KEY = 'dd_bbbbbbbb_' + 'b'.repeat(64);
const CWD = '/tmp/deerdawn-shared-machine';

// start_session resolves its project directory from CLAUDE_PROJECT_DIR (then
// process.cwd()) and syncs a brief into it. Without a temp one it writes
// .deerdawn-context.md into THIS repo and patches its CLAUDE.md, AGENTS.md and
// .cursorrules — a test that edits the checkout it is run from.
const TOUCHED_ENV = ['HOME', 'USERPROFILE', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_DIR', 'DEERDAWN_HOME'] as const;
const ORIGINAL_ENV = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));

vi.mock('../src/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth.js')>();
  return { ...actual, loadSavedApiKey: () => SOMEONE_ELSES_KEY };
});

describe('a different sign-in appearing on the machine mid-session', () => {
  let answered: number;
  let sandbox: string;

  beforeEach(() => {
    answered = 0;
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-swap-')));
    for (const key of TOUCHED_ENV) delete process.env[key];
    process.env.HOME = sandbox;
    process.env.USERPROFILE = sandbox;
    process.env.CLAUDE_PROJECT_DIR = sandbox;
    process.env.DEERDAWN_DIR = path.join(sandbox, '.deerdawn');
    resetCredentialState();
    forgetWriteTargets();
    // The client this process started with, and the renewal route that puts a
    // new one into it. Both are what index.ts wires up for real.
    noteLiveCredential(SESSION_KEY);
    setCredentialRenewalListener((key) => noteLiveCredential(key));
  });

  afterEach(() => {
    resetCredentialState();
    forgetWriteTargets();
    vi.restoreAllMocks();
    for (const key of TOUCHED_ENV) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /**
   * A client whose first context read 401s and whose second succeeds — the real
   * shape of the failure. Everything else start_session touches on the way past
   * is an async no-op: this case is about what the RETRY does, not about the
   * brief it eventually renders.
   */
  const getClient = async () => {
    // Every request 401s until the live credential is the one on disk — which
    // is exactly what an expired key does, and exactly what makes the retry
    // succeed once the swap has happened.
    const guard = <T>(answer: () => T) => async () => {
      if (liveCredential() !== SOMEONE_ELSES_KEY) {
        // A real AxiosError, because handleApiError branches on the class: a
        // look-alike falls through to "Operation failed (Error)" and the 401
        // never becomes the sentinel this whole path keys on.
        throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', {} as any, {}, {
          status: 401, data: { error: 'unauthorized' }, statusText: 'Unauthorized', headers: {}, config: {} as any,
        });
      }
      answered += 1;
      return answer();
    };
    const stub: Record<string, unknown> = {
      getContextMap: guard(() => ({ map: '[DeerDawn - 1 project]\nTheir Project (p_theirs)' })),
      getActiveContextByCwd: guard(() => ({
        brief: 'Current task: whatever this account was doing.',
        project_id: 'p_theirs', project_name: 'Their Project', match_kind: 'path',
      })),
    };
    return new Proxy(stub, {
      // `then` must stay undefined: a proxy that answers it is a thenable, and
      // awaiting this client would then call it instead of resolving.
      get: (target, prop) => {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return prop in target ? target[prop as string] : guard(() => ({}));
      },
    }) as any;
  };

  it('still recovers, because a renewal by the same person looks exactly like this', async () => {
    const result: any = await handleToolCall('start_session', {}, getClient);

    // The retry ran, under the adopted key, and answered.
    expect(answered).toBeGreaterThan(0);
    expect(String(result?.content?.[0]?.text ?? '')).toContain('whatever this account was doing');
  });

  it('says so once, instead of continuing as if nothing happened', async () => {
    const result: any = await handleToolCall('start_session', {}, getClient);
    const said = result.content.map((part: any) => String(part?.text ?? '')).join('\n');

    expect(said).toMatch(/different sign-in/i);
    expect(said).toMatch(/start a new session/i);

    // Once. Repeating it on every later call would train people to skip it.
    const later: any = await handleToolCall('recall', { action: 'map' }, getClient);
    const laterSaid = (later?.content ?? []).map((part: any) => String(part?.text ?? '')).join('\n');
    expect(laterSaid).not.toMatch(/different sign-in/i);
  });

  it('notices the swap wherever it happens, not only in the 401 retry', () => {
    // Three routes reach it — the pre-emptive re-read in getClient, the 401
    // retry, and a renewal announced by get_auth_status — and the FIRST is the
    // one that fires in practice: the rejection latch makes getClient re-read
    // credentials.json before the tool runs, so the tool succeeds and the retry
    // never happens. Recorded where the key becomes live, which all three share.
    resetCredentialState();
    noteLiveCredential(SESSION_KEY);
    expect(consumeCredentialSwapNotice()).toBe(false); // a first adoption replaces nothing

    noteLiveCredential(SOMEONE_ELSES_KEY);
    expect(consumeCredentialSwapNotice()).toBe(true);
    expect(consumeCredentialSwapNotice()).toBe(false); // once

    // Re-adopting the key already live is not a swap.
    noteLiveCredential(SOMEONE_ELSES_KEY);
    expect(consumeCredentialSwapNotice()).toBe(false);
  });

  it('drops the project targeting it resolved under the previous sign-in', async () => {
    // Remembered while the OLD key was live: a project id belonging to whoever
    // was signed in then. Following it under a new credential is how a write
    // lands in the wrong person's memory.
    const offline = { getActiveContextByCwd: async () => null } as any;
    rememberWriteTarget(CWD, 'project_from_the_old_account', 'Old Account Project');
    expect(await resolveWriteTarget(offline, CWD)).toMatchObject({ kind: 'target', projectId: 'project_from_the_old_account' });

    await handleToolCall('start_session', {}, getClient);

    expect(await resolveWriteTarget(offline, CWD)).toEqual({ kind: 'none' });
  });
});
