import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { listTools } from '../src/tools/index.js';

/**
 * The README is an instruction sheet people paste from, so it has to describe a
 * server that exists.
 *
 * It did not. The recovery sequence under "Verify installation" told a signed-out
 * user to run `manage_memory {"action":"import_local"}` and then `start_session`
 * — in that order — while handleToolCall refuses EVERY tool but start_session and
 * the setup tools until start_session has succeeded once. So the documented way
 * out of "not authenticated" answered the user with a refusal, on the first call
 * they make after signing in, at the exact moment they are deciding whether this
 * product works.
 *
 * Both checks below compare the document against the code rather than against a
 * remembered snapshot, so the next change to either one has to face the other.
 */
const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

/** Tools callable before start_session has run — see handleToolCall's gate. */
const CALLABLE_FIRST = new Set(['start_session', 'get_auth_status', 'get_setup_status', 'apply_setup', 'complete_setup']);

/** The fenced block that follows `heading`, as its lines. */
function fencedBlockAfter(heading: string): string[] {
  const at = README.indexOf(heading);
  expect(at, `README should still contain: ${heading}`).toBeGreaterThan(-1);
  const open = README.indexOf('```', at);
  const close = README.indexOf('```', open + 3);
  expect(close).toBeGreaterThan(open);
  return README.slice(README.indexOf('\n', open) + 1, close)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('the README against the server it documents', () => {
  it('never tells you to call a tool before start_session has run', () => {
    const steps = fencedBlockAfter("If `start_session` reports you're not authenticated");
    const called = steps.map((line) => line.split(/[\s{]/)[0]);
    expect(called).toContain('start_session');

    const beforeStartSession = called.slice(0, called.indexOf('start_session'));
    for (const tool of beforeStartSession) {
      expect(CALLABLE_FIRST, `README calls ${tool} before start_session, which the server refuses`).toContain(tool);
    }
  });

  it('counts the listed tools the way listTools actually does', () => {
    // The table in "Session memory tools" states these three numbers. They are
    // the first thing a reader checks against their own tool list, so they are
    // pinned to the function rather than to a memory of it.
    expect(listTools({ authed: true, hasSkills: false })).toHaveLength(6);
    expect(listTools({ authed: true, hasSkills: true })).toHaveLength(8);
    expect(listTools({ authed: false, hasSkills: false })).toHaveLength(10);

    expect(README).toMatch(/\| Local, signed in \| 6:/);
    expect(README).toMatch(/which makes 8/);
    expect(README).toMatch(/\| Local, signed out \| the above plus 4 setup tools/);
  });
});
