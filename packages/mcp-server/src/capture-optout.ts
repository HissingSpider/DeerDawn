// The switches that turn passive capture off.
//
// DeerDawn records three things nobody asked it to in the moment: the shell
// commands an agent runs, which files changed, and the session transcript at
// Stop. There was no way to decline them short of hand-editing the hooks out of
// ~/.claude/settings.json, which the next boot put straight back.
//
// Two ways to decline, either one enough:
//   - `DEERDAWN_CAPTURE=off` (also `0`, `false`, `no`, `disabled`);
//   - answering no to the capture question in `setup` (setup-choices.ts).
// Both are read in two places on purpose:
//   - autoConfigureHooks, so the capture hooks are not installed and ones
//     already there are taken out;
//   - every hook entry point, so hooks that are ALREADY installed — by an older
//     version, or on a machine where the variable reaches the shell but not the
//     MCP server's env block — become no-ops before they read or send anything.
// start_session and every explicit tool call are unaffected: those are things
// the user or the agent did on purpose, not capture.
//
// Declining is not the same as never having said yes. Capture hooks are only
// INSTALLED after a yes (autoConfigureHooks); what this answers is whether hooks
// that are installed may run. With no answer recorded they were installed by an
// install that predates the question, which autoConfigureHooks keeps, so they may.

import { readSetupChoices, type SetupChoices } from './setup-choices.js';

const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disabled']);

/** DEERDAWN_CAPTURE alone: the environment's answer, whatever setup recorded. */
export function isCaptureDisabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.DEERDAWN_CAPTURE;
  if (typeof raw !== 'string') return false;
  return OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Is capture declined? The environment, and — when the caller did not hand in an
 * environment of its own — the answer recorded at setup.
 */
export function isCaptureDisabled(
  env: Record<string, string | undefined> = process.env,
  choices: SetupChoices | null = env === process.env ? readSetupChoices() : null,
): boolean {
  if (isCaptureDisabledByEnv(env)) return true;
  return choices?.capture === 'off';
}
