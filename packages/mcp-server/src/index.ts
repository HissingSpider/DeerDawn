import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config.js';
import { DeerdawnClient } from './client.js';
import { loadSavedApiKey, saveApiKey, loadPendingAuth, isPendingAuthFresh, isTerminalAuthFailure, runDeviceFlow, resumeDeviceFlow, awaitPendingSignIn, autoConfigureHooks, restoreGlobalClaudeMdBlock, hasClaudeAiDeerDawnConnection, inspectClaudeCodeHooks, detectCursorServerKinds, codexHomeDir, readCodexConfig } from './auth.js';
import { buildClaudeMcpAddArgs, describeClaudeHooksResult, formatClaudeMcpAddCommand, recordHookApiUrl, resolveSetupKey, resolveSetupApiUrl, planSetupSignIn, persistBootEnvKey, DEFAULT_API_URL } from './setup-plan.js';
import { checkApiKeyDetailed } from './tools/auth.js';
import { recordRejectedPinnedKey } from './hook-api-key.js';
import { setCredentialRenewalListener, credentialsWereRejected, liveCredential, noteLiveCredential, notePinnedEnvKeyReplaced } from './auth-state.js';
import { listTools, handleToolCall } from './tools/index.js';
import { listResources, readResource } from './resources/index.js';
import { listPrompts, getPrompt } from './prompts/index.js';
import { flushSession, runFlushSessionCli } from './flush-session.js';
import { emitSessionContext } from './session-context.js';
import { syncProjectFiles, findGitRoot, isLocationMatch } from './project-sync.js';
import { readSetupChoices, writeSetupChoices } from './setup-choices.js';
import { isCaptureDisabledByEnv } from './capture-optout.js';
import { askYesNo } from './setup-prompt.js';
import { previewRepoSeed, hasAnythingToSeed, describeRepoSeedPreview, seedRepoBrief, buildCodexAgentsBlock, writeCodexAgentsBlock, CODEX_BLOCK_HEADING } from './repo-seed.js';
// Same first-run seed start_session runs, so a surface that never calls
// start_session still ends session one with a real brief.
import { runFirstRunImport } from './tools/context-sync.js';
import { buildGlobalProfileSeed } from './first-run-import.js';
import { recordRuntimeFailure, recordRuntimeSuccess } from './runtime-health.js';
import { captureWorktreeChange, primeWorktreeSnapshot } from './worktree-capture.js';
import { captureCommandFromHook } from './command-capture.js';
import { telemetryPathCategory, telemetryErrorCode } from './telemetry-safe.js';
import { runPeerCheck } from './peer-check.js';
import { buildMcpInstructions } from './instruction-block.js';
import { detectCodexServerKinds } from './on-disk-instructions.js';
import { recordDetectedSurface, resolveLocalSurfaceOrNull, getDetectedClientMeta } from './surface.js';
import { removeStaleBlock, removePlainTextKeys, adoptForeignBlock } from './managed-block.js';
import { inspectLocalSetupStatus } from '../../shared-context/src/setup-status.js';
import { detectSurfaceState } from './surface-state.js';
import { buildTaskBoardSnapshot, formatTaskBoardText } from '../../shared-context/src/index.js';
import { formatBriefReceipt, briefReceiptInputs } from '../../shared-context/src/briefReceipt.js';
// Inlined at build time by tsup/esbuild — keeps serverInfo.version and --version
// in lockstep with the published package version (was hardcoded "1.0.0").
import { version as PKG_VERSION } from '../package.json';
// What setup prints after "Authorized": the rest of the install happens below,
// and then one thing is left for the person to do.
const SETUP_NEXT_STEP = '   Next: setup finishes below. Then start a new Claude Code session in your project; the brief loads before the first reply.';
// The one line about capture the person reads before answering (Thing 4.4).
const CAPTURE_EXPLAINER =
  'Automatic capture (optional): at the end of each Claude Code session, the redacted transcript, the Bash commands\n'
  + 'your agent ran and which files changed are sent to api.deerdawn.com, where a model extracts decisions and next steps\n'
  + 'into your brief. Without it, DeerDawn saves only what you or your AI choose to save.';
// Enough of the brief to recognise it; every session loads the whole thing.
const SETUP_BRIEF_MAX_LINES = 40;
const AUTH_TOOL_NAMES = new Set(['get_auth_status', 'get_setup_status', 'apply_setup', 'complete_setup']);
const startupCompliance = {
  start_session_called: false,
  compliant_count: 0,
  skipped_count: 0,
};

// ── Crash-loop / orphan protection ──────────────────────────────────────────
// A stdio MCP server whose client dies inherits broken stdout/stderr pipes.
// Writing to them throws EPIPE; if that is merely logged-and-swallowed it becomes
// an uncaught-exception storm that spins the event loop at 100% CPU indefinitely
// (observed: a 92-hour orphan). Defend on three fronts: treat a broken pipe as
// "client gone → exit", make the error log itself unable to throw, and trip a
// circuit breaker if errors arrive in a tight storm.
function isBrokenPipe(err: unknown): boolean {
  const code = (err as { code?: string; errno?: string })?.code
    ?? (err as { errno?: string })?.errno;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ECONNRESET';
}
function safeStderr(msg: string): void {
  try { process.stderr.write(msg); } catch { /* pipe is gone — never re-throw */ }
}

let errorBurst = 0;
let burstTimer: ReturnType<typeof setTimeout> | null = null;
function noteError(): void {
  if (++errorBurst >= 25) {
    safeStderr('[DeerDawn] error storm — exiting to avoid a CPU spin\n');
    process.exit(1);
  }
  if (!burstTimer) {
    burstTimer = setTimeout(() => { errorBurst = 0; burstTimer = null; }, 5000);
    burstTimer.unref?.();
  }
}

// Keep the process alive on transient background task failures — but never spin.
process.on('uncaughtException', (err: unknown) => {
  if (isBrokenPipe(err)) process.exit(0);   // client/pipe gone — leave quietly
  safeStderr(`[DeerDawn] uncaught error: ${err instanceof Error ? err.message : String(err)}\n`);
  noteError();
});
process.on('unhandledRejection', (reason: unknown) => {
  if (isBrokenPipe(reason)) process.exit(0);
  safeStderr(`[DeerDawn] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  noteError();
});
// If our own stdio breaks (client died mid-write), exit rather than loop on it.
process.stdout.on('error', (e: unknown) => { if (isBrokenPipe(e)) process.exit(0); });
process.stderr.on('error', () => { /* nothing safe to log here — swallow */ });

// Flush session context on dirty interrupt (token exhaustion, kill, crash)
async function shutdownFlush(signal: string): Promise<void> {
  safeStderr(`[DeerDawn] ${signal} received — flushing session\n`);
  // Watchdog: a slow or hung flush must never keep an exiting process alive.
  const watchdog = setTimeout(() => process.exit(0), 3000);
  watchdog.unref?.();
  // No hook payload here, and never stdin: in this process stdin is the MCP
  // channel. Codex is the one host whose flush needs no session id, and the
  // handshake already told us whether that is who we are serving.
  // The live key, not a re-resolution: this process knows which credential the
  // session is actually using (a swapped-in sign-in included).
  try { await flushSession({ codex: resolveLocalSurfaceOrNull() === 'codex', apiKey: liveCredential() }); } catch { /* best-effort */ }
  process.exit(0);
}
process.once('SIGTERM', () => { shutdownFlush('SIGTERM'); });
process.once('SIGINT', () => { shutdownFlush('SIGINT'); });

// CLI dispatch — runs before the MCP server starts
const cliCommand = process.argv[2];
const USAGE = `DeerDawn MCP server — AI session memory over stdio.

Usage: deerdawn-mcp [command]

Run with no command to start the MCP server on stdio (this is what MCP
clients such as Claude Code, Cursor, and Codex invoke).

Commands:
  tasks [project]          Show a compact task board (active project by default)
  setup [--api-url URL]    Register with Claude Code, sign in, configure hooks.
                           --api-url (or DEERDAWN_API_URL) points it at a
                           self-hosted DeerDawn; default https://api.deerdawn.com
  remove-block <tool>      Remove DeerDawn's instruction block from a tool with no
                           DeerDawn server (tool: claude_code, codex or cursor)
  remove-key               Delete the DeerDawn API key that an older setup left in
                           plain text in a file its tool does not read
  adopt-block <tool>       Take over a DeerDawn block another install wrote, when this
                           is the only machine that writes the file
  flush-session            Flush session context (Stop hook)
  session-context          Emit the project brief as a SessionStart hook payload
  prime-worktree           Snapshot the worktree for change capture (hook)
  capture-worktree-change  Record worktree changes since the last snapshot (hook)
  capture-command          Record a command from a PostToolUse hook
  peer-check               Warn about overlapping agents from a PreToolUse hook
  await-sign-in            Finish a sign-in the SessionStart hook started (hook)

Options:
  -h, --help     Show this help
  -v, --version  Print the package version

Docs: https://deerdawn.com/docs/mcp-server
`;
if (cliCommand === '--help' || cliCommand === '-h') {
  // Explicit CLI invocation — stdout is the right channel here (an MCP client
  // never passes --help; unknown args still fall through to the server below).
  process.stdout.write(USAGE);
  process.exit(0);
} else if (cliCommand === '--version' || cliCommand === '-v') {
  process.stdout.write(`${PKG_VERSION}\n`);
  process.exit(0);
} else if (cliCommand === 'flush-session') {
  runFlushSessionCli().then(() => process.exit(0)).catch(() => process.exit(0));
} else if (cliCommand === 'session-context') {
  emitSessionContext().then(() => process.exit(0)).catch(() => process.exit(0));
} else if (cliCommand === 'await-sign-in') {
  // Left running, detached, by a SessionStart hook that handed the person a
  // sign-in link (startDetachedSignIn): a link nobody polls completes in the
  // browser and reaches nothing.
  // The spawner passes the API it started the flow against in DEERDAWN_API_URL.
  awaitPendingSignIn(process.env.DEERDAWN_API_URL || 'https://api.deerdawn.com')
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch(() => process.exit(1));
} else if (cliCommand === 'prime-worktree') {
  try {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    primeWorktreeSnapshot(cwd);
  } catch { /* non-fatal */ }
  process.exit(0);
} else if (cliCommand === 'capture-worktree-change') {
  captureWorktreeChange(process.env.DEERDAWN_SURFACE_ID === 'codex' ? 'codex' : 'claude_code')
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
} else if (cliCommand === 'peer-check') {
  // Sits in front of every Edit/Write, so it must exit fast and exit quiet.
  // Local file reads only — never the network — and it always exits 0 so a
  // failure here can never block an edit.
  runPeerCheck().then(() => process.exit(0)).catch(() => process.exit(0));
} else if (cliCommand === 'capture-command') {
  captureCommandFromHook()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
} else if (cliCommand === 'setup') {
  // A setup that could not sign in used to exit 0. `npx ... setup && next-step`
  // therefore carried on, every installer script that checks $? called it a
  // success, and the only evidence to the contrary was a line of stderr nobody
  // had reason to read. The reason is printed by runSetup; the exit code has to
  // agree with it.
  const resolvedApi = resolveSetupApiUrl(process.argv.slice(3), process.env);
  if (resolvedApi.error) {
    console.error(`Setup: ${resolvedApi.error}`);
    process.exit(2);
  }
  // Everything setup starts from here (the device flow, the registration, the
  // detached sign-in listener) reads DEERDAWN_API_URL; make it the chosen one.
  process.env.DEERDAWN_API_URL = resolvedApi.apiUrl;
  runSetup().then((ok) => process.exit(ok ? 0 : 1)).catch((err) => {
    console.error('Setup failed:', err.message);
    process.exit(1);
  });
} else if (cliCommand === 'remove-block') {
  // Only on request, and only for a tool with no DeerDawn server behind the block.
  const target = process.argv[3];
  const outcome = removeStaleBlock(target ?? '', { runningSurface: null });
  process.stdout.write(outcome.removed
    ? `Removed DeerDawn's block from ${outcome.path}. A copy of the file as it was is in ${outcome.backup_path}.\n${outcome.note ? `${outcome.note}\n` : ''}`
    : `Nothing removed. ${outcome.reason}\n`);
  process.exit(outcome.removed ? 0 : 1);
} else if (cliCommand === 'remove-key') {
  const outcomes = removePlainTextKeys();
  if (!outcomes.length) process.stdout.write('No file holds a DeerDawn API key in plain text where its tool does not read one. Nothing changed.\n');
  for (const outcome of outcomes) {
    process.stdout.write(outcome.removed
      ? `Removed the DeerDawn API key from ${outcome.path}. The copy of the file taken first has the key blanked out (${outcome.backup_path})${outcome.redacted_backups ? `, and ${outcome.redacted_backups} older backup(s) that held it were blanked too` : ''}.\n`
      : `Not removed from ${outcome.path}: ${outcome.reason}\n`);
  }
  process.exit(outcomes.some((outcome) => !outcome.removed) ? 1 : 0);
} else if (cliCommand === 'adopt-block') {
  const outcome = adoptForeignBlock(process.argv[3] ?? '');
  process.stdout.write(outcome.adopted
    ? `The DeerDawn block in ${outcome.path} is now this install's. A copy of the file as it was is in ${outcome.backup_path}. The next start refreshes it.\n`
    : `Nothing changed. ${outcome.reason}\n`);
  process.exit(outcome.adopted ? 0 : 1);
} else if (cliCommand === 'tasks') {
  runTasks(process.argv.slice(3).join(' ').trim() || undefined)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`Couldn’t load the task board: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
} else {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

async function runTasks(projectQuery?: string) {
  const rawConfig = loadConfig();
  const apiKey = rawConfig.apiKey ?? loadSavedApiKey() ?? null;
  if (!apiKey) throw new Error('not signed in. Run `deerdawn-mcp setup` first.');
  const client = new DeerdawnClient({ ...rawConfig, apiKey });

  let projectId: string | undefined;
  let projectName: string | undefined;
  if (projectQuery) {
    const result = await client.listContextProjects();
    const projects = result?.projects ?? [];
    const query = projectQuery.toLowerCase();
    const exact = projects.find((project: any) =>
      project.project_id === projectQuery || String(project.project_name || '').toLowerCase() === query
    );
    const partial = projects.filter((project: any) => String(project.project_name || '').toLowerCase().includes(query));
    const match = exact ?? (partial.length === 1 ? partial[0] : null);
    if (!match) {
      if (partial.length > 1) throw new Error(`project name is ambiguous: ${partial.map((p: any) => p.project_name).join(', ')}`);
      throw new Error(`no project matches “${projectQuery}”.`);
    }
    projectId = match.project_id;
    projectName = match.project_name;
  }

  const boardCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const context = projectId
    ? await client.getContextJson(projectId)
    : await client.getContextJson(undefined, { cwd: boardCwd });
  if (!context?.project_id && !projectId) throw new Error('no active project. Pass a project name or ID.');
  const snapshot = buildTaskBoardSnapshot(context, {
    project_id: projectId ?? context.project_id,
    project_name: projectName ?? context.project_name,
  });
  process.stdout.write(`${formatTaskBoardText(snapshot)}\n`);
}

/** Resolves true when setup finished, false when it could not sign in. */
async function runSetup(): Promise<boolean> {
  const { existsSync, readFileSync } = await import('fs');
  const { join, sep } = await import('path');
  const { homedir } = await import('os');
  const { execFileSync } = await import('child_process');
  const home = homedir();

  // Resolve API key: env → saved credentials → device flow (browser: see planSetupSignIn)
  const apiUrl = process.env.DEERDAWN_API_URL || DEFAULT_API_URL;
  if (apiUrl !== DEFAULT_API_URL) console.log(`DeerDawn API: ${apiUrl}`);
  const envApiKey = process.env.DEERDAWN_API_KEY?.trim() || null;
  const savedApiKey = loadSavedApiKey();
  // The registration below no longer carries the key in its env (see
  // buildClaudeMcpAddArgs), so credentials.json is the only place the server
  // will find it. A key supplied through the shell env gets persisted there,
  // exactly as a device-flow sign-in would — including over a saved key that has
  // stopped working, which is the case this used to skip (see resolveSetupKey).
  const keyChoice = await resolveSetupKey(
    envApiKey,
    savedApiKey,
    async (key) => (await checkApiKeyDetailed(apiUrl, key)).state,
  );
  let apiKey = keyChoice.apiKey;
  const setupNotes: string[] = [];
  // A credential that could not be stored means the NEXT run has nothing, which
  // is not a setup that finished. Tracked rather than returned on the spot so
  // the rest of the summary is still printed: the user needs to see what did
  // land as well as what did not.
  const CREDENTIAL_NOT_SAVED = '  API key      ✗  Could not write ~/.deerdawn/credentials.json (see the message above) — this run works, the next one will not';
  let credentialSaved = true;
  if (keyChoice.persistEnvKey && envApiKey) {
    // saveApiKey reports the cause on stderr; this puts it in the summary the
    // user is actually reading, because "setup succeeded" beside an unsaved
    // credential is the report that sends people round the loop again.
    if (!saveApiKey(envApiKey)) {
      setupNotes.push(CREDENTIAL_NOT_SAVED);
      credentialSaved = false;
    }
  }
  if (!apiKey) {
    console.log('\nDeerDawn Setup\n' + '─'.repeat(50));
    // See planSetupSignIn: setup opens the browser it says it opens, whenever
    // there is a person and a screen to open it for, and prints the link always.
    const signIn = planSetupSignIn({ env: process.env, platform: process.platform, stdoutIsTTY: Boolean(process.stdout.isTTY) });
    console.log(signIn.announcement);
    try {
      const flow = await runDeviceFlow(apiUrl, signIn.openBrowser, undefined, SETUP_NEXT_STEP);
      apiKey = flow.apiKey;
      // The same note the env-key branch has pushed since #500. This branch —
      // the one a NEW user takes — threw the answer away, so a symlinked
      // credentials.json or an unwritable ~/.deerdawn produced a summary of
      // ticks and "Done. Restart Claude Code to activate DeerDawn" over an
      // install that will ask for a sign-in again on its very next start.
      if (!flow.saved) {
        setupNotes.push(CREDENTIAL_NOT_SAVED);
        credentialSaved = false;
      }
    } catch (err) {
      // Surface the real cause — a bare "Browser sign-in failed" hid 429s and
      // network errors and sent users into a retry loop with zero diagnostic.
      const message = err instanceof Error ? err.message : String(err);
      const rateLimited = /rate.?limit|too_many_requests|\b429\b/i.test(message);
      // A refusal the printed link cannot outlive: the code is expired, spent,
      // or rate-limited past its own window. See isTerminalAuthFailure.
      const terminal = isTerminalAuthFailure(err);
      console.error(`  ✗  Sign-in could not be completed: ${message}`);

      // If an authorization link was already issued, show it — opening it in any
      // browser (even on another machine) still authorizes this install.
      // Third copy of the freshness question, and the weakest: it consulted only
      // expires_at, which the API has never actually sent (/start returns
      // expires_in), so the condition was always true and this printed stale
      // links indefinitely. One helper now answers it everywhere.
      //
      // Never after a terminal refusal. The message directly above has just said
      // that link cannot be retried, and printing it as the way forward
      // contradicts it — worse, "then re-run setup" is actively harmful there:
      // somebody who authorizes the dead link and then re-runs mints a SECOND
      // code, and the key the first one produced is stranded unclaimed.
      const pending = terminal ? null : loadPendingAuth();
      const pendingUrl =
        pending?.verification_url && isPendingAuthFresh(pending) ? pending.verification_url : null;
      if (pendingUrl) {
        console.error(`     Sign in manually in any browser: ${pendingUrl}`);
        console.error('     Then re-run setup to finish:  npx -y @deerdawn/mcp-server@latest setup');
      }

      if (rateLimited) {
        console.error('     Rate limited — wait a minute before retrying; re-running setup immediately will hit the limit again.');
      } else if (!pendingUrl) {
        console.error('     Re-run setup for a fresh authorization link:  npx -y @deerdawn/mcp-server@latest setup');
      }
      console.error('');
      return false;
    }
  }

  const results: string[] = [];
  if (keyChoice.note) results.push(keyChoice.note);
  results.push(...setupNotes);

  // 1. Register MCP server with Claude Code (idempotent)
  const claudeJsonPath = join(home, '.claude.json');
  let alreadyRegistered = false;
  let pinnedEnvKey = false;
  let registeredApiUrl: string | null = null;
  if (existsSync(claudeJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      alreadyRegistered = !!parsed?.mcpServers?.deerdawn;
      pinnedEnvKey = !!parsed?.mcpServers?.deerdawn?.env?.DEERDAWN_API_KEY;
      registeredApiUrl = parsed?.mcpServers?.deerdawn?.env?.DEERDAWN_API_URL ?? null;
    } catch { /* ignore */ }
  }

  if (!alreadyRegistered) {
    try {
      // Use execFileSync with argument array — no shell interpolation
      execFileSync('claude', buildClaudeMcpAddArgs(apiUrl), { stdio: 'pipe' });
      results.push('  Claude Code  ✓  MCP server registered');
    } catch {
      results.push('  Claude Code  –  Could not auto-register MCP server. Run manually:\n' +
        `     ${formatClaudeMcpAddCommand(apiUrl)}`);
    }
  } else {
    results.push('  Claude Code  ✓  MCP server already registered');
    // Registrations written by earlier versions of setup pin a 90-day key in the
    // MCP env, which outranks credentials.json and so outlives every re-sign-in.
    // Not rewritten automatically: a hand-set key there may be deliberate.
    if (pinnedEnvKey) {
      results.push('  Claude Code  !  The registration pins DEERDAWN_API_KEY in its env, which overrides ~/.deerdawn/credentials.json\n' +
        '               and stops working when that key expires. To use your saved sign-in instead, re-register:\n' +
        '     claude mcp remove -s user deerdawn && npx -y @deerdawn/mcp-server@latest setup');
    }
    // Registered against another DeerDawn (hosted vs a self-hosted server, or a
    // moved one): the server would keep talking to that one. Not rewritten
    // automatically, for the same reason as above.
    if (registeredApiUrl && registeredApiUrl.replace(/\/+$/, '') !== apiUrl) {
      results.push(`  Claude Code  !  The registration points at ${registeredApiUrl}, not ${apiUrl}. To switch it, re-register:\n` +
        `     claude mcp remove -s user deerdawn && npx -y @deerdawn/mcp-server@latest setup${apiUrl === DEFAULT_API_URL ? '' : ` --api-url ${apiUrl}`}`);
    }
  }

  // The SessionStart and Stop hooks are separate processes Claude Code starts
  // WITHOUT the server's env block, so they find the API in
  // ~/.deerdawn/config.json (api_url) and otherwise use the hosted default.
  // Record a self-hosted URL there, or the hooks of a self-hosted install send
  // its key to api.deerdawn.com.
  const apiUrlNote = recordHookApiUrl(apiUrl);
  if (apiUrlNote) results.push(apiUrlNote);

  // 2. Configure hooks and CLAUDE.md: Claude Code's, and no other tool's. This
  // command registers DeerDawn with Claude Code; Codex and Cursor below are read
  // and reported, never written.
  //
  // Capture first, because it decides which hooks are written. Opt-in: asked
  // here with one line on what leaves the machine and where extraction runs.
  // With nobody at the terminal the recorded answer stands, and with none
  // recorded capture stays off (see captureWanted in auth.ts).
  const priorCapture = readSetupChoices().capture;
  if (!isCaptureDisabledByEnv()) {
    console.log('\n' + CAPTURE_EXPLAINER);
    const capture = await askYesNo('Turn on automatic capture?', priorCapture === 'on');
    if (capture !== null) writeSetupChoices({ capture: capture ? 'on' : 'off', capture_source: 'setup' });
    else console.log(`(No terminal to answer in: capture ${priorCapture === 'on' ? 'stays on' : 'stays off'}. Re-run setup in a terminal to change it.)`);
  }
  // The global ~/.claude/CLAUDE.md block, removed by the person: never re-added
  // by a boot or an agent's apply_setup, only here, on their own yes.
  if (readSetupChoices().global_claude_md === 'removed') {
    const restore = await askYesNo('\nYou removed DeerDawn\'s block from ~/.claude/CLAUDE.md, so it is not added back. Add it back now?', false);
    if (restore) {
      results.push(restoreGlobalClaudeMdBlock()
        ? '  Claude Code  ✓  DeerDawn\'s block is back in ~/.claude/CLAUDE.md'
        : '  Claude Code  –  Could not write ~/.claude/CLAUDE.md; the block was not added');
    }
  }
  autoConfigureHooks({ tool: 'claude_code' });
  results.push(describeClaudeHooksResult(inspectClaudeCodeHooks()));

  // A tick says the tool can reach DeerDawn, so it is read from where each tool
  // keeps its servers, never from the instruction file beside them. It used to
  // be: "Codex ✓ ~/.codex/AGENTS.md" and "Cursor ✓" printed on a machine where
  // neither had a DeerDawn server registered, beside an order to call
  // start_session that Codex could not follow. The connect step is the one each
  // tool's setup guide gives (connectCopy.ts).
  const hostedMcpUrl = `${apiUrl.replace(/\/+$/, '')}/mcp`;
  // Codex reads $CODEX_HOME when it is set, and config.toml as TOML: a
  // registration in inline or dotted form counts, and a file Codex cannot parse
  // is said to be one (running `codex mcp add` on it fails the same way).
  const shown = (file: string) => (file.startsWith(home + sep) ? `~${file.slice(home.length)}` : file);
  const codexDir = codexHomeDir(home);
  const codexConfig = readCodexConfig(home);
  const codexAgents = join(codexDir, 'AGENTS.md');
  const codexConnect = `     codex mcp add deerdawn --url ${hostedMcpUrl} && codex mcp login deerdawn`;
  if (detectCodexServerKinds(home).length) {
    results.push(`  Codex        ✓  MCP server registered in ${shown(codexConfig.path)}${existsSync(codexAgents) ? ` + ${shown(codexAgents)}` : ''}`);
  } else if (!codexConfig.parsed) {
    results.push(`  Codex        –  Not connected: ${shown(codexConfig.path)} cannot be parsed as TOML (${codexConfig.error}), so Codex cannot load it. Fix it, then:\n` +
      codexConnect);
  } else if (existsSync(codexDir)) {
    results.push(`  Codex        –  Not connected: no DeerDawn server in ${shown(codexConfig.path)}. To connect:\n` +
      codexConnect);
  } else {
    results.push('  Codex        –  Not found (open Codex once, then re-run)');
  }
  // Cursor also reads a project's own .cursor/mcp.json, so a registration there
  // is a connection in this project even with nothing in the global file.
  const cursorMdc = join(home, '.cursor', 'rules', 'deerdawn.mdc');
  const cursorRule = existsSync(cursorMdc) ? ' + ~/.cursor/rules/deerdawn.mdc' : '';
  if (detectCursorServerKinds(home).length) {
    results.push(`  Cursor       ✓  MCP server registered in ~/.cursor/mcp.json${cursorRule}`);
  } else if (detectCursorServerKinds(home, process.env.CLAUDE_PROJECT_DIR || process.cwd()).length) {
    results.push(`  Cursor       ✓  MCP server registered in this project's .cursor/mcp.json${cursorRule}`);
  } else if (existsSync(join(home, '.cursor'))) {
    results.push('  Cursor       –  Not connected: no DeerDawn server in ~/.cursor/mcp.json. To connect, add under "mcpServers":\n' +
      `     "deerdawn": { "url": "${hostedMcpUrl}" }`);
  } else {
    results.push('  Cursor       –  Not found (install Cursor first)');
  }
  // A block an earlier version left in a tool's instruction file with no server
  // behind it orders a call the tool cannot make. No boot removes it: Codex can
  // take a server from a `-c` override, a `-p` profile file or /etc/codex, and
  // Cursor from another project's .cursor/mcp.json, none of which DeerDawn can
  // see (checked against codex-cli 0.154). So it is kept, and named here, in the
  // command a person runs on purpose, with the file, the tool and the way to
  // remove it. The same for a plain-text API key that an older setup wrote into a
  // file its tool does not read.
  const leftovers = (inspectLocalSetupStatus as unknown as (source: string, options: { runningSurface: string | null }) => unknown)('local_direct', { runningSurface: null }) as {
    surfaces: Array<{ stale_block?: { summary: string } | null; foreign_block?: { summary: string } | null }>;
    diagnostics?: { plain_text_keys?: Array<{ summary: string }> };
  };
  for (const surface of leftovers.surfaces) {
    if (surface.stale_block) results.push(`  Left as is   !  ${surface.stale_block.summary}`);
    if (surface.foreign_block) results.push(`  Left as is   !  ${surface.foreign_block.summary}`);
  }
  for (const leaked of leftovers.diagnostics?.plain_text_keys ?? []) {
    results.push(`  Left as is   !  ${leaked.summary}`);
  }

  // 3. Sync project files for current directory
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let client: DeerdawnClient | null = null;
  let projectName: string | null = null;
  try {
    const config = { ...loadConfig(), apiKey };
    client = new DeerdawnClient(config);
    // Claude Code's project files only: setup configures the tool it registers.
    // This is also where the repo gets DeerDawn's instruction (the CLAUDE.md
    // pointer to .deerdawn-context.md): only a repo with a DeerDawn project gets
    // one. The global ~/.claude/CLAUDE.md block is no longer added (auth.ts).
    projectName = await syncProjectFiles(client, cwd, undefined, { tools: ['claude_code'] });
  } catch {
    results.push('  Project      –  Could not sync (check API connection)');
  }

  // 4. No project here yet: offer to build the first brief from the repo, after
  // showing which files would be read. Asked, never assumed; no terminal is a no.
  if (client && !projectName) {
    const preview = previewRepoSeed(cwd);
    let seeded = false;
    if (hasAnythingToSeed(preview)) {
      console.log('\nNo DeerDawn project for this folder yet. DeerDawn can start its brief from:');
      describeRepoSeedPreview(preview).forEach((line) => console.log(line));
      console.log('   Secrets are masked before anything is sent to api.deerdawn.com, where a model extracts the brief.\n'
        + '   Your answer also decides whether a new repo\'s first session may read these files without asking.');
      const answer = await askYesNo('Build the first brief from these files?', false);
      if (answer !== null) writeSetupChoices({ repo_seed: answer ? 'yes' : 'no' });
      if (answer) {
        try {
          const seed = await seedRepoBrief(client, cwd, preview, () => runFirstRunImport(client!, cwd, undefined, { consented: true }));
          if (seed.projectId) {
            seeded = true;
            projectName = await syncProjectFiles(client, cwd, undefined, { tools: ['claude_code'] }) ?? seed.projectName;
            results.push(`  Project      ✓  First brief started for "${seed.projectName}" (${seed.notes.join(', ')})`);
          }
        } catch (err) {
          results.push(`  Project      –  Could not build the first brief: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (!seeded) {
      results.push('  Project      –  No project for this folder yet. In Claude Code, say: "Set up a DeerDawn brief for this project"');
    }
  } else if (projectName) {
    results.push(`  Project      ✓  Briefed → "${projectName}"`);
  }

  // 5. Codex reads the repo's AGENTS.md. When Codex is on this machine and this
  // folder has a project, offer the block (activation plan §3) — into THIS
  // repo's AGENTS.md, never a global file, and only after a yes.
  let active: any = null;
  if (client && projectName) {
    try { active = await client.getActiveContextByCwd(cwd, 'claude_code', 'standard'); } catch { active = null; }
  }
  const activeMatches = Boolean(active?.project_id && isLocationMatch(active?.match_kind));
  const readFileSafe = (file: string): string => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  if (activeMatches && (existsSync(codexDir) || detectCodexServerKinds(home).length)) {
    const block = buildCodexAgentsBlock(active.project_name || projectName || '', active.project_id);
    const root = findGitRoot(cwd) || cwd;
    if (readFileSafe(join(root, 'AGENTS.md')).includes(CODEX_BLOCK_HEADING)) {
      results.push('  Codex        ✓  This repo\'s AGENTS.md already has the DeerDawn block');
    } else {
      console.log('\nCodex is on this machine. This block in this repo\'s AGENTS.md lets Codex start each task from the brief:\n');
      console.log(block.split('\n').map((line) => `   ${line}`).join('\n'));
      const answer = await askYesNo('\nAdd it to AGENTS.md in this repo?', false);
      if (answer) {
        const outcome = writeCodexAgentsBlock(root, block);
        results.push(outcome === 'written'
          ? `  Codex        ✓  Added the DeerDawn block to ${join(root, 'AGENTS.md')}`
          : `  Codex        –  Could not write ${join(root, 'AGENTS.md')}; paste the block above into it yourself`);
      } else if (answer === null) {
        results.push('  Codex        –  To have Codex start from the brief, re-run setup in a terminal, or paste the block from\n'
          + '               https://deerdawn.com/agent-setup/codex.md into this repo\'s AGENTS.md');
      }
    }
  }

  console.log('\nDeerDawn Setup\n' + '─'.repeat(50));
  results.forEach(r => console.log(r));

  // 6. The brief itself, so the person sees what their next session starts from.
  if (activeMatches && active?.brief) {
    const lines = String(active.brief).split('\n');
    const shown = lines.slice(0, SETUP_BRIEF_MAX_LINES);
    console.log(`\nYour brief${active.project_name ? ` for ${active.project_name}` : ''}\n` + '─'.repeat(50));
    // The receipt /active renders (shared-context briefReceipt.js); an API that
    // predates it gets the same line from the same formatter, over the stored
    // context, so the person sees one wording wherever it comes from.
    let receipt: string | null = active.receipt ?? null;
    if (!receipt && client) {
      try {
        const ctx = await client.getContextJson(active.project_id);
        const inputs = ctx && typeof ctx === 'object'
          ? briefReceiptInputs({ project_name: ctx.project_name ?? active.project_name, updated_at: ctx.updated_at ?? active.last_updated, context: ctx })
          : null;
        receipt = inputs ? formatBriefReceipt(inputs) : null;
      } catch { receipt = null; }
    }
    if (receipt) console.log(`${receipt}\n`);
    console.log(shown.join('\n'));
    if (lines.length > shown.length) console.log(`… ${lines.length - shown.length} more lines. Every new session loads all of it.`);
  }

  // "Done" is a claim about the NEXT run, not this one. With no stored
  // credential the next start has nothing to find, so the closing line says what
  // is left to do and the exit code agrees — `npx ... setup && next-step` read
  // exit 0 as permission to carry on.
  console.log(credentialSaved
    ? (activeMatches
      ? '\nDone. Next: start a new Claude Code session in this folder (restart Claude Code if it is open). Your brief loads before the first reply.\n'
      : '\nDone. Next: start a new Claude Code session in this folder (restart Claude Code if it is open) and say:\n   "Set up a DeerDawn brief for this project"\n')
    : '\nNot finished: the API key could not be saved, so the next start will ask you to sign in again.\nFix the path above, then re-run setup.\n');
  return credentialSaved;
}

async function main() {
  console.error('Starting Deerdawn MCP server...');

  try {
    const rawConfig = loadConfig();

    // Resolve API key: env → saved credentials → device flow
    const resolvedApiKey = rawConfig.apiKey ?? loadSavedApiKey() ?? null;

    // Deferred client promise — always pending until auth resolves, never rejects.
    // Rejection is captured in authError so getClient() returns a structured MCP error
    // instead of crashing the process.
    let resolveClient!: (c: DeerdawnClient) => void;
    let client: DeerdawnClient | null = null;
    let authError: Error | null = null;
    // Set once the server is constructed below. Best-effort throughout: a client
    // that ignores list_changed just keeps the wider list, which is the
    // conservative direction to be wrong in.
    let notifyToolsChanged: () => void = () => { /* server not up yet */ };
    const clientPromise = new Promise<DeerdawnClient>((resolve) => {
      resolveClient = resolve;
    });

    // The ONE place a key becomes a live client. Four routes reach it — a key
    // already on disk, the boot device flow, a renewal announced by the detached
    // poll behind get_auth_status, and a credentials.json some other process
    // wrote — and whoever arrives first wins.
    //
    // A promise resolves once, so the client is held in a variable the getter
    // reads rather than by re-resolving: a key arriving after one is built is
    // handed to the client we already have (applyApiKey swaps the header in
    // place) instead of quietly building a second one that nothing points at.
    // That is also what settles the race between a still-running boot flow and a
    // renewal — the loser's key is adopted, its client is never constructed.
    const adoptApiKey = (apiKey: string): DeerdawnClient => {
      if (client) {
        // Replacing the key pinned in the MCP server config means this session
        // recovers and the install does not: that key outranks credentials.json
        // at the next boot. Recorded here, at the swap, because two different
        // routes reach it and only one of them goes through get_auth_status —
        // which is where this used to be the only place it was said.
        const pinnedEnvKey = rawConfig.apiKey?.trim();
        if (pinnedEnvKey && pinnedEnvKey !== apiKey && liveCredential() === pinnedEnvKey) {
          notePinnedEnvKeyReplaced();
          // The hooks read the same pinned key from the same registration, and
          // would go on sending it after this process moved on. When the API is
          // what refused it, record that (a hash, never the key) so they skip
          // it too. A swap with no 401 behind it — a deliberate sign-in as
          // somebody else — says nothing about the pinned key, and is not
          // recorded. See hook-api-key.ts.
          if (credentialsWereRejected()) recordRejectedPinnedKey(pinnedEnvKey);
        }
        client.applyApiKey(apiKey);
        // Recorded AFTER the header swap, so "the live client holds this key" is
        // never claimed before it is true. Everything that recovers an expired
        // session reads this rather than the file, because a valid key on disk
        // that this process has not adopted is precisely the state that made
        // "DeerDawn reconnected" a lie. See auth-state.ts.
        noteLiveCredential(apiKey);
        return client;
      }
      client = new DeerdawnClient({ ...rawConfig, apiKey });
      noteLiveCredential(apiKey);
      // A boot flow that had already failed left authError set forever. Auth is
      // no longer failed, and leaving the flag up is exactly what made the dead
      // end permanent: the getter kept throwing for the life of the process
      // while a working credential sat on disk beside it.
      authError = null;
      resolveClient(client);
      autoConfigureHooks();
      // Auth just flipped, so the advertised tool surface is now wrong: the host
      // is holding a list that still includes the setup tier. Tell it to
      // re-read. Deferred through a holder because `server` is constructed
      // further down this function while a device flow runs async.
      notifyToolsChanged();
      return client;
    };

    // Registered in BOTH branches, which is the fix.
    //
    // It used to exist only where a key was already present, so a server whose
    // boot-time device flow failed (a 503 during a deploy, a 429, an offline
    // boot, or simply the window closing) had NO route from "the user signed in
    // through the link get_auth_status handed them" back to a working client.
    // The credential reached disk, stderr announced the session was reconnected,
    // get_auth_status answered {"authenticated":true}, and every real tool call
    // still said "DeerDawn: not signed in" until the host app was restarted.
    setCredentialRenewalListener((apiKey) => { adoptApiKey(apiKey); });

    if (resolvedApiKey) {
      console.error(`Configuration loaded — API URL: ${rawConfig.apiUrl}`);
      // A key on disk is not a key that works, and this branch cannot tell the
      // difference without a network call it should not make at boot. So it
      // proceeds optimistically and subscribes to the correction: the first 401
      // marks the credential rejected, get_auth_status is advertised again,
      // and the sign-in it starts hands the new key straight back here.
      // Without this the whole recovery path terminated in a file nobody reread.
      adoptApiKey(resolvedApiKey);
      // A key that arrived ONLY through this process's env block is invisible
      // to the hooks adoptApiKey just installed. Hand it to them the way setup
      // does — see persistBootEnvKey. Background: boot must not wait on it.
      if (rawConfig.apiKey && rawConfig.apiKey.trim() === resolvedApiKey) {
        void persistBootEnvKey(rawConfig.apiKey, {
          loadSaved: loadSavedApiKey,
          check: async (key) => (await checkApiKeyDetailed(rawConfig.apiUrl, key)).state,
          save: saveApiKey,
        }).then((outcome) => {
          if (outcome === 'saved') console.error('[DeerDawn] Saved DEERDAWN_API_KEY to ~/.deerdawn/credentials.json so the capture hooks can authenticate.');
        }).catch(() => null);
      }
    } else {
      // Start or resume device flow without blocking the server from starting.
      void (async () => {
        try {
          const autoOpen = hasClaudeAiDeerDawnConnection();
          const pending = loadPendingAuth();
          // Freshness lives in isPendingAuthFresh so this rule and the one in
          // tools/auth.ts cannot drift. They already had: this one correctly
          // refused to resume a stale flow, while get_auth_status happily served
          // the same stale link, so the server minted a new code that the user
          // was never shown.
          const canResume = !!(
            pending?.device_code &&
            !pending.error_message &&
            isPendingAuthFresh(pending)
          );
          // The key works whether or not it reached disk, and the boot path has
          // no summary to print into: saveApiKey has already said on stderr what
          // did not land. `setup` is the caller that acts on it.
          const apiKey = canResume && pending!.device_code
            ? await resumeDeviceFlow(rawConfig.apiUrl, pending!.device_code, pending!.verification_url ?? '', pending!.expires_at)
            : (await runDeviceFlow(rawConfig.apiUrl, autoOpen, 'you\'re connected via Claude.ai')).apiKey;
          adoptApiKey(apiKey);
        } catch (err) {
          const failure = err instanceof Error ? err : new Error(String(err));
          // Only when nothing has authenticated in the meantime. A renewal can
          // land while this flow is still polling, and the loser's RESULT is
          // dropped — including when that result is a failure, which must not
          // put a working session back into the error state.
          if (client) return;
          authError = failure;
          console.error('Auth flow failed:', failure.message);
          // Say the thing that is true and actionable: this process can still be
          // signed in without restarting it.
          console.error('[DeerDawn] Sign-in is still possible in this session — call get_auth_status for a fresh link, then retry your tool.');
        }
      })();
    }

    // getClient is passed to handlers. Returns a structured MCP error if auth failed,
    // so Claude can surface the reason instead of seeing a silent crash.
    const getClient = async (): Promise<DeerdawnClient> => {
      if (client) {
        // A client we already hold can still be holding a DEAD key: a second
        // server process on this machine (two editor windows) signs in, writes
        // credentials.json, and announces nothing to us. This used to return the
        // client unconditionally, so the file that is the only channel between
        // processes was read once at boot and never again by anyone already
        // running — and every recovery path downstream reported the DISK as the
        // session's state.
        //
        // Gated on the rejection latch so the healthy path pays no disk read:
        // the latch is only up once a 401 has actually come back.
        if (credentialsWereRejected()) {
          const savedApiKey = loadSavedApiKey();
          if (savedApiKey && savedApiKey !== liveCredential()) adoptApiKey(savedApiKey);
        }
        return client;
      }
      // Somebody may have signed in since the boot flow gave up. Two ways, and
      // neither of them is an event this process hears: the detached poll behind
      // get_auth_status writes credentials.json in THIS process (it also
      // announces, so this is belt and braces), and a SECOND server process on
      // the same machine writes the same file and announces nothing at all. The
      // file is the only channel between processes, so read it before refusing.
      const savedApiKey = loadSavedApiKey();
      if (savedApiKey) return adoptApiKey(savedApiKey);
      if (authError) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `DeerDawn auth required: ${authError.message}. Call get_auth_status for a sign-in link, then retry — no restart needed.`,
        );
      }
      return clientPromise;
    };

    // Background: sync project files and seed global profile on connect
    clientPromise.then(async (client) => {
      try {
        recordRuntimeSuccess({ toolName: 'startup' });
        await client.recordProductEvent({
          event_name: 'mcp_runtime_started',
          source: 'mcp',
          surface: resolveLocalSurfaceOrNull(),
          path: telemetryPathCategory(process.cwd()),
          metadata: { execution_source: 'stdio', ...getDetectedClientMeta() },
        }).catch(() => null);
        // 1. Sync project files for the current directory (writes .deerdawn-context.md,
        //    patches CLAUDE.md, AGENTS.md, .cursorrules so all tools get context immediately).
        //    Defer past the agent's mandated first start_session so this connect-time
        //    sync never races it — start_session does the same ~900ms fetch + skill
        //    sync, and running both at once doubled cold-start server load and
        //    inflated the felt start_session time. Once start_session has run it has
        //    already synced, so skip the redundant work here (the global profile seed
        //    below still runs — start_session doesn't do that).
        const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
        await new Promise((r) => setTimeout(r, 1500));
        if (!startupCompliance.start_session_called) {
          await syncProjectFiles(client, cwd).catch(() => { /* non-fatal */ });
        }

        const global = await client.getContextMap().catch(() => null);
        const hasProjects = global?.project_count > 0 || (global?.map && global.map.length > 20);

        // 2. If nothing is tracked yet, seed from the local context file.
        //
        // This used to print a tip to STDERR telling the user to run
        // `manage_memory` with action import_local. Stderr is the MCP server's
        // log, not the conversation — so that advice reached nobody, and a first
        // connection ended with an empty brief while the CLAUDE.md that IS the
        // brief sat in the same directory. It imports now.
        //
        // start_session normally gets there first (it runs the same gated
        // helper); this is the fallback for surfaces that never call it. The
        // per-process claim inside runFirstRunImport settles the race between
        // them, and the on-disk ledger stops it recurring next session.
        if (!hasProjects && !startupCompliance.start_session_called) {
          const seeded = await runFirstRunImport(client, cwd).catch(() => null);
          if (seeded) {
            console.error(`[DeerDawn] ${seeded.split('\n')[0]}`);
          }
        }

        // 3. Seed global user profile if not set yet
        const hasProfile = global?.map?.includes('About:') || global?.map?.includes('You:');
        if (hasProfile) return;

        // Gated and redacted inside buildGlobalProfileSeed: no standing opt-in,
        // no read and no upload. This block used to readFileSync the user's
        // ~/.claude/CLAUDE.md and send what it found, unasked and unmasked.
        const patch = buildGlobalProfileSeed(process.cwd());
        if (patch) {
          await client.updateGlobalContext(patch);
          console.error('Auto-seeded global context from local CLAUDE.md');
        }
      } catch (error: unknown) {
        recordRuntimeFailure({
          message: error instanceof Error ? error.message : 'startup_failed',
          toolName: 'startup',
        });
      }
    });

    const server = new Server(
      {
        name: 'deerdawn-mcp',
        title: 'DeerDawn',
        version: PKG_VERSION,
        description:
          'AI session memory: the brief your AI reads before every session so no session starts cold. Loads your project\'s current task, recent decisions, and open questions across Claude, ChatGPT, Cursor, and Codex.',
        websiteUrl: 'https://deerdawn.com',
        icons: [
          { src: 'https://deerdawn.com/android-chrome-512x512.png', mimeType: 'image/png', sizes: ['512x512'] },
          { src: 'https://deerdawn.com/android-chrome-192x192.png', mimeType: 'image/png', sizes: ['192x192'] },
          { src: 'https://deerdawn.com/favicon-32x32.png', mimeType: 'image/png', sizes: ['32x32'] },
        ],
      },
      {
        // tools.listChanged declares that our advertised list is dynamic, so hosts
        // honour notifications/tools/list_changed when auth or project state
        // narrows the surface after startup.
        capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
        // Surfaced automatically by the MCP host into the model's system
        // context on initialize — no user action required.
        instructions: buildMcpInstructions(),
      }
    );

    // Now that the server exists, let the async auth flow above narrow the
    // advertised surface when it completes.
    notifyToolsChanged = () => {
      server.notification({ method: 'notifications/tools/list_changed' })
        .catch(() => { /* client may not support list_changed */ });
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // State-driven surface — see the tier comments in tools/index.ts. Detection
      // is local-file-only so this stays a sub-millisecond answer; on any doubt it
      // returns the full list rather than risk hiding a tool the session needs.
      const state = detectSurfaceState();
      const tools = listTools(state);
      console.error(`Listing tools: ${tools.length} advertised (authed=${state.authed}, bound=${state.hasBoundProject}, skills=${state.hasSkills})`);
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.error(`Calling tool: ${name}`);
      try {
        if (name === 'start_session') {
          startupCompliance.start_session_called = true;
          startupCompliance.compliant_count += 1;
        } else if (!AUTH_TOOL_NAMES.has(name) && !startupCompliance.start_session_called) {
          startupCompliance.skipped_count += 1;
          getClient().then((client) => client.recordProductEvent({
            event_name: 'mcp_start_session_skipped',
            source: 'mcp',
            surface: resolveLocalSurfaceOrNull(),
            path: telemetryPathCategory(process.cwd()),
            metadata: {
              tool_name: name,
              skipped_count: startupCompliance.skipped_count,
              compliant_count: startupCompliance.compliant_count,
              ...getDetectedClientMeta(),
            },
          }).catch(() => null)).catch(() => null);
        }
        const result = await handleToolCall(name, args || {}, getClient);
        recordRuntimeSuccess({ toolName: name });
        getClient().then((client) => client.recordProductEvent({
          event_name: name === 'start_session' ? 'mcp_start_session_succeeded' : 'mcp_tool_call_succeeded',
          source: 'mcp',
          surface: resolveLocalSurfaceOrNull(),
          path: telemetryPathCategory(process.cwd()),
          metadata: { tool_name: name, ...getDetectedClientMeta() },
        }).catch(() => null)).catch(() => null);
        console.error(`Tool call successful: ${name}`);
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'tool_call_failed';
        const errorClass = error instanceof Error
          ? String(error.name || 'Error').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32)
          : 'UnknownError';
        recordRuntimeFailure({ message, toolName: name });
        getClient().then((client) => client.recordProductEvent({
          event_name: 'mcp_tool_call_failed',
          source: 'mcp',
          surface: resolveLocalSurfaceOrNull(),
          path: telemetryPathCategory(process.cwd()),
          // A code, not the message: messages quote paths, URLs and rejected input.
          metadata: { tool_name: name, error: telemetryErrorCode(error), error_class: errorClass, ...getDetectedClientMeta() },
        }).catch(() => null)).catch(() => null);
        console.error(`Tool call failed: ${name} [${errorClass}]`, message);
        throw error;
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      console.error('Listing resources');
      return { resources: listResources() };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      console.error(`Reading resource: ${uri}`);
      try {
        const client = await Promise.race([
          getClient(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('DeerDawn auth pending. Call get_auth_status for the sign-in URL.')), 3000)
          ),
        ]);
        const result = await readResource(uri, client);
        recordRuntimeSuccess({ toolName: `resource:${uri}` });
        console.error(`Resource read successful: ${uri}`);
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'resource_read_failed';
        recordRuntimeFailure({ message, toolName: `resource:${uri}` });
        console.error(`Resource read failed: ${uri}`, message);
        throw error;
      }
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      console.error('Listing prompts');
      return { prompts: listPrompts() };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.error(`Getting prompt: ${name}`);
      try {
        const client = await getClient();
        const result = await getPrompt(name, args || {}, client);
        recordRuntimeSuccess({ toolName: `prompt:${name}` });
        console.error(`Prompt generated: ${name}`);
        return result;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'prompt_failed';
        recordRuntimeFailure({ message, toolName: `prompt:${name}` });
        console.error(`Prompt generation failed: ${name}`, message);
        throw error;
      }
    });

    // Tool identity fallback: once the initialize handshake lands, remember the
    // client's self-reported name so telemetry surfaces resolve even when the
    // host config didn't set DEERDAWN_SURFACE_ID (generated configs mostly don't).
    server.oninitialized = () => {
      const info = server.getClientVersion();
      recordDetectedSurface(info?.name, info?.version);
      // A boot that could not yet say which tool it serves configured nothing
      // (see autoConfigureHooks). Now it can, so that tool's files are written.
      if (client) autoConfigureHooks();
    };

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Deerdawn MCP server running on stdio');

    // When the client/parent goes away, stdin reaches EOF (or closes). Exit
    // instead of lingering as an orphan — the root cause of the 100% CPU spin.
    // Only wired here on the long-lived server path (CLI subcommands manage
    // their own stdin); normal operation keeps stdin open, so these never fire
    // until the client actually disconnects.
    let exiting = false;
    const exitOnClientGone = (why: string): void => {
      if (exiting) return;
      exiting = true;
      void shutdownFlush(why);
    };
    process.stdin.on('end', () => exitOnClientGone('stdin-end'));
    process.stdin.on('close', () => exitOnClientGone('stdin-close'));
    transport.onclose = () => exitOnClientGone('transport-close');

  } catch (error: unknown) {
    console.error('Fatal error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
