// What the person answered at setup, and what DeerDawn has learned about their
// files since — kept in ~/.deerdawn/setup-choices.json.
//
// Three things used to happen to everybody with no question asked, on every
// server start, not only in setup:
//   - the capture hooks (Stop, PostToolUse) were installed, so the session
//     transcript, Bash commands and file edits left the machine;
//   - DeerDawn's block went into the global ~/.claude/CLAUDE.md, and came back on
//     the next start after the person deleted it;
//   - the local first session read the README and the last commits without
//     asking.
// Each is now a choice, and the choice has to outlive the process that asked,
// because autoConfigureHooks runs at every boot and the first session runs in a
// later process still. One small file, read at call time, never cached: a person
// who changes their mind by re-running setup is taken at their word at once.
//
// An ABSENT answer is not a yes. Each reader says what it does without one.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { safeWriteFileSync } from './utils/safe-fs.js';

export type SetupChoices = {
  /** Capture hooks: 'on' only after a yes (or an install that already had them, see capture_source). */
  capture?: 'on' | 'off';
  /** Where the capture answer came from: asked at setup, or kept from an install that predates the question. */
  capture_source?: 'setup' | 'existing_install';
  /** When the person was told, once, that an earlier version had switched capture on for them. */
  capture_notice_shown_at?: string;
  /** May the first brief be built from the README, CLAUDE.md/AGENTS.md and recent commit subjects without asking again? */
  repo_seed?: 'yes' | 'no';
  /**
   * The global ~/.claude/CLAUDE.md block: 'kept' once a boot has seen it there,
   * 'removed' once a boot saw it gone after that. 'removed' is the person's
   * opt-out and is never undone by a boot.
   */
  global_claude_md?: 'kept' | 'removed';
  global_claude_md_removed_at?: string;
};

function deerdawnDir(): string {
  return process.env.DEERDAWN_DIR
    || (process.env.DEERDAWN_HOME_DIR ? path.join(process.env.DEERDAWN_HOME_DIR, '.deerdawn') : null)
    || path.join(os.homedir(), '.deerdawn');
}

export function setupChoicesPath(): string {
  return path.join(deerdawnDir(), 'setup-choices.json');
}

/** The recorded answers; {} when none are recorded or the file cannot be read. */
export function readSetupChoices(): SetupChoices {
  try {
    const parsed = JSON.parse(fs.readFileSync(setupChoicesPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SetupChoices : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the recorded answers. Returns whether it reached disk.
 * Never throws: a choice that cannot be stored leaves the safe default (no
 * capture, no global block, ask before reading) in force, which is the right
 * direction to fail in.
 */
export function writeSetupChoices(patch: Partial<SetupChoices>): boolean {
  try {
    const dir = deerdawnDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const next = { ...readSetupChoices(), ...patch };
    return safeWriteFileSync(setupChoicesPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch {
    return false;
  }
}

/** Did the person say the first brief may be read from the repo without asking again? */
export function repoSeedConsented(): boolean {
  return readSetupChoices().repo_seed === 'yes';
}
