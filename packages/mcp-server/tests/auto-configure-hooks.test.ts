import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { autoConfigureHooks } from '../src/auth.js';
import { isDeerdawnCommand } from '../src/hook-commands.js';
import { readSetupChoices, writeSetupChoices } from '../src/setup-choices.js';
import { OPEN_MARKER, CLOSE_MARKER } from '../src/instruction-block.js';

// os.homedir() honors $HOME on POSIX, so we sandbox HOME to a temp dir and
// assert the capture hooks land in ~/.claude/settings.json.
describe('autoConfigureHooks', () => {
  let home: string;
  let prevHome: string | undefined;
  const settingsPath = () => path.join(home, '.claude', 'settings.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-hooks-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
    // Capture is opt-in (Thing 4.4). These cases are the merge mechanics for
    // somebody who said yes at setup; the opt-in itself is covered below.
    writeSetupChoices({ capture: 'on', capture_source: 'setup' });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('creates settings.json and installs capture hooks for a brand-new user', () => {
    // No ~/.claude dir at all — the regression case that previously installed nothing.
    autoConfigureHooks({ tool: 'claude_code' });

    expect(fs.existsSync(settingsPath())).toBe(true);
    const { hooks } = readSettings();
    expect(hooks.Stop?.[0]?.hooks?.[0]?.command).toContain('flush-session');
    expect(hooks.SessionStart?.[0]?.hooks?.[0]?.command).toContain('session-context');
    expect(hooks.PostToolUse?.[0]?.matcher).toBe('Write|Edit|MultiEdit');
    expect(hooks.PostToolUse?.[1]?.matcher).toBe('Bash');
  });

  it('preserves unrelated settings keys when merging into an existing file', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ model: 'opus', env: { FOO: '1' } }));

    autoConfigureHooks({ tool: 'claude_code' });

    const settings = readSettings();
    expect(settings.model).toBe('opus');
    expect(settings.env).toEqual({ FOO: '1' });
    expect(settings.hooks.Stop).toBeDefined();
  });

  it('does not clobber a malformed existing settings.json', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ not valid json');

    // Parse throws and is swallowed by the function's outer catch — the bad file
    // is left untouched rather than overwritten with defaults.
    expect(() => autoConfigureHooks({ tool: 'claude_code' })).not.toThrow();
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ not valid json');
  });

  it("preserves the user's own hooks under Stop/SessionStart/PostToolUse", () => {
    // A user with their own hooks under the very events DeerDawn manages. The old
    // code overwrote the whole array and destroyed these; the merge must keep them.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const userStop = { matcher: '', hooks: [{ type: 'command', command: 'echo user-stop' }] };
    const userPost = { matcher: 'Write', hooks: [{ type: 'command', command: 'my-linter --fix' }] };
    const userSession = { matcher: '', hooks: [{ type: 'command', command: 'echo user-session' }] };
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { Stop: [userStop], SessionStart: [userSession], PostToolUse: [userPost] },
    }));

    autoConfigureHooks({ tool: 'claude_code' });

    const { hooks } = readSettings();
    // User groups survive...
    expect(hooks.Stop).toContainEqual(userStop);
    expect(hooks.SessionStart).toContainEqual(userSession);
    expect(hooks.PostToolUse).toContainEqual(userPost);
    // ...and DeerDawn's capture groups are present alongside them.
    expect(hooks.Stop.some((g: any) => g.hooks?.[0]?.command?.includes('flush-session'))).toBe(true);
    expect(hooks.SessionStart.some((g: any) => g.hooks?.[0]?.command?.includes('session-context'))).toBe(true);
    expect(hooks.PostToolUse.some((g: any) => g.matcher === 'Bash')).toBe(true);
    // User's own Write hook is untouched — DeerDawn adds its own Write|Edit|MultiEdit group.
    expect(hooks.PostToolUse.filter((g: any) => g.matcher === 'Write')).toEqual([userPost]);
  });

  it('is idempotent — repeated boots do not duplicate DeerDawn hooks', () => {
    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'claude_code' });

    const { hooks } = readSettings();
    const deerdawnGroups = (arr: any[]) => arr.filter((g: any) => g.deerdawnManaged === true);
    expect(deerdawnGroups(hooks.Stop)).toHaveLength(1);
    expect(deerdawnGroups(hooks.SessionStart)).toHaveLength(1);
    expect(deerdawnGroups(hooks.PostToolUse)).toHaveLength(2);
  });

  it('replaces a legacy untagged DeerDawn hook without duplicating it', () => {
    // Entries written by the pre-tag version have no `deerdawnManaged` flag; they
    // are recognized by the `deerdawn-mcp` command and refreshed in place.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'deerdawn-mcp flush-session' }] }],
      },
    }));

    autoConfigureHooks({ tool: 'claude_code' });

    const { hooks } = readSettings();
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop[0].deerdawnManaged).toBe(true);
  });

  it('tags every managed group so future boots can find them', () => {
    autoConfigureHooks({ tool: 'claude_code' });
    const { hooks } = readSettings();
    for (const event of ['Stop', 'SessionStart', 'PostToolUse'] as const) {
      for (const group of hooks[event]) {
        expect(group.deerdawnManaged).toBe(true);
      }
    }
  });

  // ─── The dead-bin migration ────────────────────────────────────────────────
  // Every install before this wrote `deerdawn-mcp ...`, which npx never puts on
  // PATH. A boot must rewrite those in place: no duplicates, the user's own hooks
  // untouched and in their original order.

  const allCommands = (hooks: any) =>
    Object.values(hooks).flatMap((groups: any) => groups.flatMap((g: any) => (g.hooks || []).map((h: any) => h.command)));

  it('never writes a command that starts with the bare deerdawn-mcp bin', () => {
    autoConfigureHooks({ tool: 'claude_code' });
    const { hooks } = readSettings();
    const ours = allCommands(hooks).filter(isDeerdawnCommand);
    expect(ours.length).toBeGreaterThan(0);
    for (const cmd of ours) {
      expect(cmd).not.toMatch(/(^|[\s;&|])deerdawn-mcp(\s|$)/);
      expect(cmd.startsWith('npx -y')).toBe(true);
      expect(cmd).toContain('@deerdawn/mcp-server@latest');
    }
  });

  it('gives every managed hook an explicit timeout sized for an npx cold start', () => {
    autoConfigureHooks({ tool: 'claude_code' });
    const { hooks } = readSettings();
    for (const event of ['Stop', 'SessionStart', 'PreToolUse', 'PostToolUse']) {
      for (const group of hooks[event]) {
        for (const h of group.hooks) {
          expect(typeof h.timeout).toBe('number');
          expect(h.timeout).toBeGreaterThanOrEqual(10);
        }
      }
    }
    expect(hooks.SessionStart[0].hooks[0].timeout).toBeGreaterThanOrEqual(30);
  });

  it('migrates a full set of stale tagged hooks in place, keeping user hooks and order', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const userBefore = { matcher: '', hooks: [{ type: 'command', command: 'echo before' }] };
    const userAfter = { matcher: 'Write', hooks: [{ type: 'command', command: 'my-linter --fix' }] };
    const stale = (matcher: string, command: string) => ({ deerdawnManaged: true, matcher, hooks: [{ type: 'command', command }] });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: {
        Stop: [userBefore, stale('', 'deerdawn-mcp capture-worktree-change 2>/dev/null || true; deerdawn-mcp flush-session 2>/dev/null || true'), userAfter],
        SessionStart: [stale('', 'deerdawn-mcp prime-worktree 2>/dev/null || true; deerdawn-mcp session-context 2>/dev/null || echo x')],
        PostToolUse: [stale('Write|Edit|MultiEdit', 'deerdawn-mcp capture-worktree-change 2>/dev/null || true'), userAfter, stale('Bash', 'deerdawn-mcp capture-command 2>/dev/null || true')],
        PreToolUse: [stale('Write|Edit|MultiEdit', 'deerdawn-mcp peer-check 2>/dev/null || true')],
      },
    }));

    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'claude_code' });

    const { hooks } = readSettings();
    expect(allCommands(hooks).some((c: string) => /(^|[\s;&|])deerdawn-mcp\s/.test(c))).toBe(false);
    // Stop: the managed group takes the stale one's slot, between the user's two.
    expect(hooks.Stop).toHaveLength(3);
    expect(hooks.Stop[0]).toEqual(userBefore);
    expect(hooks.Stop[1].deerdawnManaged).toBe(true);
    expect(hooks.Stop[1].hooks[0].command).toContain('flush-session');
    expect(hooks.Stop[2]).toEqual(userAfter);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.PreToolUse).toHaveLength(1);
    // Both managed PostToolUse groups land at the first stale slot; the user's stays.
    expect(hooks.PostToolUse).toHaveLength(3);
    expect(hooks.PostToolUse.filter((g: any) => g.deerdawnManaged)).toHaveLength(2);
    expect(hooks.PostToolUse).toContainEqual(userAfter);
  });

  it("strips only DeerDawn's command from an untagged group the user also put a hook in", () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const userCmd = { type: 'command', command: 'echo mine' };
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [userCmd, { type: 'command', command: 'deerdawn-mcp flush-session' }] }] },
    }));

    autoConfigureHooks({ tool: 'claude_code' });

    const { hooks } = readSettings();
    expect(hooks.Stop).toHaveLength(2);
    expect(hooks.Stop).toContainEqual({ matcher: '', hooks: [userCmd] });
    expect(hooks.Stop.filter((g: any) => g.deerdawnManaged)).toHaveLength(1);
  });
});

describe('capture is opt-in, and the global CLAUDE.md block is never added back (Thing 4.3, 4.4)', () => {
  let home: string;
  let prevHome: string | undefined;
  const settingsPath = () => path.join(home, '.claude', 'settings.json');
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  const claudeMd = () => path.join(home, '.claude', 'CLAUDE.md');
  const deerdawnGroups = (groups: any) => (Array.isArray(groups) ? groups : []).filter((g: any) => g.deerdawnManaged === true);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-optin-'));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('a brand-new install with no answer gets the SessionStart brief and peer check, and no capture hooks', () => {
    autoConfigureHooks({ tool: 'claude_code' });
    const { hooks } = readSettings();
    expect(deerdawnGroups(hooks.SessionStart)).toHaveLength(1);
    expect(deerdawnGroups(hooks.PreToolUse)).toHaveLength(1);
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.PostToolUse).toBeUndefined();
    // Nothing recorded: setup can still ask.
    expect(readSetupChoices().capture).toBeUndefined();
    // The SessionStart command no longer primes the capture baseline.
    expect(hooks.SessionStart[0].hooks[0].command).not.toContain('prime-worktree');
  });

  it('an install that already had capture hooks keeps them, recorded as an existing install so the person is told once', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { Stop: [{ deerdawnManaged: true, matcher: '', hooks: [{ type: 'command', command: 'npx -y @deerdawn/mcp-server@latest flush-session' }] }] },
    }));

    autoConfigureHooks({ tool: 'claude_code' });

    const { hooks } = readSettings();
    expect(deerdawnGroups(hooks.Stop)).toHaveLength(1);
    expect(deerdawnGroups(hooks.PostToolUse)).toHaveLength(2);
    expect(readSetupChoices()).toMatchObject({ capture: 'on', capture_source: 'existing_install' });
  });

  it('a no at setup takes capture hooks out, and leaves the person\'s own', () => {
    const userStop = { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] };
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({
      hooks: { Stop: [userStop, { deerdawnManaged: true, matcher: '', hooks: [{ type: 'command', command: 'npx -y @deerdawn/mcp-server@latest flush-session' }] }] },
    }));
    writeSetupChoices({ capture: 'off', capture_source: 'setup' });

    autoConfigureHooks({ tool: 'claude_code' });

    const { hooks } = readSettings();
    expect(hooks.Stop).toEqual([userStop]);
    expect(hooks.PostToolUse).toBeUndefined();
    expect(deerdawnGroups(hooks.SessionStart)).toHaveLength(1);
  });

  it('DEERDAWN_CAPTURE=off outranks a yes', () => {
    writeSetupChoices({ capture: 'on', capture_source: 'setup' });
    process.env.DEERDAWN_CAPTURE = 'off';
    try {
      autoConfigureHooks({ tool: 'claude_code' });
    } finally {
      delete process.env.DEERDAWN_CAPTURE;
    }
    expect(readSettings().hooks.Stop).toBeUndefined();
  });

  it('a new install never writes the global ~/.claude/CLAUDE.md block, and leaves the person\'s file alone', () => {
    autoConfigureHooks({ tool: 'claude_code' });
    expect(fs.existsSync(claudeMd())).toBe(false);

    fs.writeFileSync(claudeMd(), '# Mine\n');
    autoConfigureHooks({ tool: 'claude_code' });
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe('# Mine\n');
  });

  it('a block that is there is refreshed; once the person deletes it, the removal is recorded and it never comes back', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(claudeMd(), `# Mine\n\n${OPEN_MARKER}\n## DeerDawn\nSTALE-COPY\n${CLOSE_MARKER}\n`);

    autoConfigureHooks({ tool: 'claude_code' });
    const refreshed = fs.readFileSync(claudeMd(), 'utf8');
    expect(refreshed).not.toContain('STALE-COPY');
    expect(refreshed).toMatch(/<!-- deerdawn:auto-context [0-9a-f]{32}/);
    expect(readSetupChoices().global_claude_md).toBe('kept');

    // The person deletes it.
    fs.writeFileSync(claudeMd(), '# Mine\n');
    autoConfigureHooks({ tool: 'claude_code' });
    autoConfigureHooks({ tool: 'claude_code' });

    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe('# Mine\n');
    expect(readSetupChoices().global_claude_md).toBe('removed');
    expect(readSetupChoices().global_claude_md_removed_at).toMatch(/^\d{4}-/);
  });

  it('the fallback the SessionStart command echoes no longer orders the model to call start_session', () => {
    autoConfigureHooks({ tool: 'claude_code' });
    const command: string = readSettings().hooks.SessionStart[0].hooks[0].command;
    expect(command).not.toMatch(/must call start_session/);
    const echoed = command.slice(command.indexOf("echo '") + 6, command.lastIndexOf("'"));
    expect(JSON.parse(echoed).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
});
