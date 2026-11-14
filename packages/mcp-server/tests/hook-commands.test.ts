import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hookCommand,
  hookCommandResolves,
  isDeerdawnCommand,
  managedHookStatus,
  resolveExecutable,
} from '../src/hook-commands.js';
import { buildClaudeMcpAddArgs, describeClaudeHooksResult } from '../src/setup-plan.js';

/**
 * Every hook DeerDawn wrote began `deerdawn-mcp ...`, a bin that no install path
 * puts on PATH (every install is `npx -y @deerdawn/mcp-server@latest`). The
 * hooks all exited 127 behind `|| true`, and the check that decided whether to
 * show the brief card read "tagged" as "working". These pin both halves.
 */
describe('hook commands', () => {
  let binDir: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-bin-'));
  });
  afterEach(() => fs.rmSync(binDir, { recursive: true, force: true }));

  const fakeExecutable = (name: string) => {
    const p = path.join(binDir, name);
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return p;
  };

  it('invokes the package through npx, never the bare bin', () => {
    const cmd = hookCommand('flush-session');
    expect(cmd.startsWith('npx ')).toBe(true);
    expect(cmd).toContain('@deerdawn/mcp-server@latest flush-session');
    expect(cmd).not.toMatch(/(^|\s)deerdawn-mcp\s/);
  });

  it('recognizes both the legacy bin and the npx form as ours, and nothing else', () => {
    expect(isDeerdawnCommand('deerdawn-mcp flush-session 2>/dev/null || true')).toBe(true);
    expect(isDeerdawnCommand('foo || true; deerdawn-mcp session-context')).toBe(true);
    expect(isDeerdawnCommand(hookCommand('peer-check'))).toBe(true);
    expect(isDeerdawnCommand('echo hello')).toBe(false);
    // A path that merely contains the name is not a DeerDawn invocation.
    expect(isDeerdawnCommand('cat /tmp/deerdawn-mcp-home/log.txt')).toBe(false);
    expect(isDeerdawnCommand(undefined)).toBe(false);
  });

  it('resolves a command only when its program is on PATH', () => {
    fakeExecutable('npx');
    expect(resolveExecutable('npx', binDir)).toBe(path.join(binDir, 'npx'));
    expect(hookCommandResolves(hookCommand('session-context'), binDir)).toBe(true);
    // The reported failure: the bare bin under an npx-only install.
    expect(hookCommandResolves('deerdawn-mcp session-context 2>/dev/null || echo {}', binDir)).toBe(false);
    // An empty PATH resolves nothing.
    expect(hookCommandResolves(hookCommand('session-context'), '')).toBe(false);
  });

  it('accepts an absolute program path that exists and is executable', () => {
    const abs = fakeExecutable('node');
    expect(hookCommandResolves(`${abs} /x/dist/index.js flush-session`, '')).toBe(true);
    expect(hookCommandResolves('/definitely/not/here/node x', '')).toBe(false);
  });

  it('reports a present-but-dead hook as not runnable', () => {
    fakeExecutable('npx');
    const legacy = {
      hooks: { SessionStart: [{ deerdawnManaged: true, matcher: '', hooks: [{ type: 'command', command: 'deerdawn-mcp session-context' }] }] },
    };
    expect(managedHookStatus(legacy, 'SessionStart', binDir)).toEqual({ present: true, runnable: false });

    const current = {
      hooks: { SessionStart: [{ deerdawnManaged: true, matcher: '', hooks: [{ type: 'command', command: hookCommand('session-context') }] }] },
    };
    expect(managedHookStatus(current, 'SessionStart', binDir)).toEqual({ present: true, runnable: true });

    const userOnly = { hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    expect(managedHookStatus(userOnly, 'SessionStart', binDir)).toEqual({ present: false, runnable: false });
    expect(managedHookStatus(null, 'SessionStart', binDir)).toEqual({ present: false, runnable: false });
  });
});

describe('setup', () => {
  it('does not bake the API key into the MCP registration', () => {
    const args = buildClaudeMcpAddArgs();
    expect(args.join(' ')).not.toContain('DEERDAWN_API_KEY');
    expect(args).toContain('DEERDAWN_API_URL=https://api.deerdawn.com');
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['npx', '-y', '@deerdawn/mcp-server@latest']);
  });

  const ok = { present: true, runnable: true };
  const dead = { present: true, runnable: false };
  const absent = { present: false, runnable: false };

  it('claims hook success only when the hooks can run', () => {
    expect(describeClaudeHooksResult({
      settingsFound: true,
      events: { SessionStart: ok, Stop: ok, PreToolUse: ok, PostToolUse: ok },
    })).toContain('✓');

    const deadLine = describeClaudeHooksResult({
      settingsFound: true,
      events: { SessionStart: dead, Stop: dead, PreToolUse: dead, PostToolUse: dead },
    });
    expect(deadLine).not.toContain('✓');
    expect(deadLine).toMatch(/cannot run/);

    expect(describeClaudeHooksResult({
      settingsFound: true,
      events: { SessionStart: absent, Stop: ok, PreToolUse: ok, PostToolUse: ok },
    })).not.toContain('✓');

    expect(describeClaudeHooksResult({ settingsFound: false, events: {} })).not.toContain('✓');
  });
});
