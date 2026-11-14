import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * Every vitest file starts contained (tests/setup/contain-home.ts): none of the
 * home-like variables the code honours survives from the developer's shell,
 * and HOME is a fresh temp directory of the file's own. Without this, a
 * developer with CODEX_HOME (or DEERDAWN_DIR, or CLAUDE_PROJECT_DIR) exported
 * had their real files read and rewritten by the suite.
 */

const require = createRequire(import.meta.url);
const { PATH_VARIABLES } = require('../../shared-context/tests/contain-home.cjs');

describe('the test process is contained', () => {
  it('no home-like variable reaches the test', () => {
    for (const key of PATH_VARIABLES as string[]) expect(process.env[key], key).toBeUndefined();
  });

  it('HOME is a temp directory of this file\'s own, not a shared or real one', () => {
    const home = process.env.HOME as string;
    expect(path.basename(home)).toMatch(/^dd-test-home-/);
    expect(home.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(os.homedir()).toBe(home);
    expect(process.env.USERPROFILE).toBe(home);
  });
});
