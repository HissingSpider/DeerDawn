import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleContextSyncTool, runFirstRunImport } from '../src/tools/context-sync.js';
import {
  findLocalContextFile,
  hasImportedLocalContext,
  resetFirstRunImportState,
  resolveWorkspaceDir,
  readUserAuthoredContext,
  stripDeerdawnAuthoredBlocks,
  stripDeerdawnBoilerplate,
} from '../src/first-run-import.js';
import { buildDeerdawnInstructionLines } from '../../shared-context/src/deerdawnInstructions.js';

/**
 * The automatic first-run seed.
 *
 * The behaviour under test is not "does it import" — it is "when is it allowed
 * to", because an unattended write into someone's memory has exactly one
 * unacceptable failure mode. Most of what follows asserts that it DOESN'T run,
 * or that it runs without touching what was already there.
 */

const USER_CLAUDE_MD = [
  '# Atlas',
  '',
  'Current task: Ship the ingest rewrite',
  'Current status: Wiring the new queue',
  'Tech stack:',
  '- TypeScript',
  '- Postgres',
  '',
  'Open questions:',
  '- Do we keep the legacy shim?',
  '',
  'Atlas replaced the batch importer with a streaming one last quarter, and the remaining work is',
  'mostly about draining the old queue without dropping partially-written rows on the floor.',
].join('\n');

function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-first-run-'));
  // macOS hands out /var/... which is a symlink to /private/var; resolve it so
  // the ledger key and the path the code derives are the same string.
  const real = fs.realpathSync(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(real, name), body, 'utf8');
  }
  return real;
}

function makeClient(overrides: Record<string, any> = {}) {
  return {
    flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
    getActiveContextByCwd: vi.fn().mockResolvedValue(null),
    // An account that already has other projects — the case the old gate missed.
    getContextMap: vi.fn().mockResolvedValue({ map: '[DeerDawn]\n- Billing (project_billing)' }),
    listContextProjects: vi.fn().mockResolvedValue({ projects: [] }),
    createContextProject: vi.fn().mockResolvedValue({
      project: { project_id: 'project_atlas', project_name: 'Atlas' },
    }),
    patchProjectContext: vi.fn().mockResolvedValue({ ok: true }),
    updateGlobalContext: vi.fn().mockResolvedValue({ ok: true }),
    pushContextUpdate: vi.fn().mockResolvedValue({ ok: true }),
    recordContextEvent: vi.fn().mockResolvedValue(null),
    recordProductEvent: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

const eventNames = (client: any): string[] =>
  client.recordProductEvent.mock.calls.map((call: any[]) => call[0].event_name);

describe('first-run auto-import', () => {
  let home: string;
  let previousHome: string | undefined;
  let previousProjectDir: string | undefined;

  let previousAutoImport: string | undefined;

  beforeEach(() => {
    // The ledger lives under ~/.deerdawn. Sandbox it, or a test run rewrites the
    // developer's real import history.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-home-'));
    previousHome = process.env.DEERDAWN_HOME;
    previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
    previousAutoImport = process.env.DEERDAWN_AUTO_IMPORT;
    process.env.DEERDAWN_HOME = path.join(home, '.deerdawn');
    // These cases are about what the seed DOES once it is permitted — the
    // no-overwrite rule, the ledger, the race. Whether it is permitted at all is
    // a separate question with its own file
    // (local-import-consent-and-redaction.test.ts), which pins the default OFF.
    // Standing in for the user's opt-in here keeps the two apart.
    process.env.DEERDAWN_AUTO_IMPORT = '1';
    resetFirstRunImportState();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DEERDAWN_HOME;
    else process.env.DEERDAWN_HOME = previousHome;
    if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
    if (previousAutoImport === undefined) delete process.env.DEERDAWN_AUTO_IMPORT;
    else process.env.DEERDAWN_AUTO_IMPORT = previousAutoImport;
    resetFirstRunImportState();
    vi.restoreAllMocks();
  });

  it('seeds this workspace even when the account already has other projects', async () => {
    // The old gate was account-wide, so this exact case — a returning user
    // opening their second repo — started cold with a CLAUDE.md sitting there.
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';

    expect(text).toContain('First run in this workspace');
    expect(text).toContain('CLAUDE.md');
    expect(text).toContain('Imported "Atlas"');
    expect(client.createContextProject).toHaveBeenCalledTimes(1);
    expect(client.patchProjectContext.mock.calls[0][1]).toMatchObject({
      current_task: 'Ship the ingest rewrite',
      current_status: 'Wiring the new queue',
      tech_stack: ['TypeScript', 'Postgres'],
    });
    // A brand-new project gets the prose too — that is what fills the brief.
    expect(client.pushContextUpdate).toHaveBeenCalledTimes(1);
    // Session one ends briefed rather than pointing at a command to run.
    expect(text).not.toContain('No DeerDawn context yet');
  });

  it('leaves an existing brief for this directory completely alone', async () => {
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient({
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_atlas',
        project_name: 'Atlas',
        brief: 'Current task: something a real session already recorded.',
        last_updated: new Date().toISOString(),
      }),
    });

    const result = await handleContextSyncTool('start_session', {}, client as any);
    const text = result.content?.[0]?.text || '';

    expect(text).toContain('Resuming Atlas');
    expect(client.createContextProject).not.toHaveBeenCalled();
    expect(client.patchProjectContext).not.toHaveBeenCalled();
    expect(eventNames(client)).not.toContain('context_import_started');
  });

  it('fills the project this directory is bound to instead of creating a twin', async () => {
    // A path-linked project with no brief yet is the empty shell the card is
    // about. Deriving a name from the file heading here is what puts a second
    // project beside the first for the same repo.
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient({
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_bound',
        project_name: 'ingest-service',
        match_kind: 'path',
        brief: '',
      }),
      getContextJson: vi.fn().mockResolvedValue({}),
    });

    const text = (await handleContextSyncTool('start_session', {}, client as any)).content?.[0]?.text || '';

    expect(client.createContextProject).not.toHaveBeenCalled();
    expect(client.listContextProjects).not.toHaveBeenCalled();
    expect(client.patchProjectContext.mock.calls[0][0]).toBe('project_bound');
    expect(text).toContain('ingest-service');
    // Bound but empty, so the prose still runs through extraction.
    expect(client.pushContextUpdate).toHaveBeenCalledTimes(1);
  });

  it('refuses to seed against a merely guessed project match', async () => {
    // 'recency_fallback' / 'name' are guesses at some other work-stream. Writing
    // into one is how an import lands in the wrong project.
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient({
      getActiveContextByCwd: vi.fn().mockResolvedValue({
        project_id: 'project_unrelated',
        project_name: 'Something Else',
        match_kind: 'recency_fallback',
        brief: '',
      }),
    });

    await handleContextSyncTool('start_session', {}, client as any);

    expect(client.createContextProject).not.toHaveBeenCalled();
    expect(client.patchProjectContext).not.toHaveBeenCalled();
    expect(hasImportedLocalContext(cwd)).toBe(false);
  });

  it('does not import a second time, even in a fresh process', async () => {
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;

    const first = makeClient();
    await handleContextSyncTool('start_session', {}, first as any);
    expect(first.createContextProject).toHaveBeenCalledTimes(1);
    expect(hasImportedLocalContext(cwd)).toBe(true);

    // Clearing the in-process claim proves the ON-DISK ledger is what holds the
    // line: deleting an imported project is a decision, and re-seeding over it
    // next session would silently undo it.
    resetFirstRunImportState();

    const second = makeClient();
    await handleContextSyncTool('start_session', {}, second as any);
    expect(second.createContextProject).not.toHaveBeenCalled();
    expect(second.patchProjectContext).not.toHaveBeenCalled();
  });

  it('creates the project once when two callers race in the same process', async () => {
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    // start_session and the connect-time startup path can both arrive within
    // milliseconds; without the per-process claim that is two projects.
    const [a, b] = await Promise.all([
      runFirstRunImport(client as any, cwd),
      runFirstRunImport(client as any, cwd),
    ]);

    expect(client.createContextProject).toHaveBeenCalledTimes(1);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('fills only the blanks when a project of that name already has context', async () => {
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient({
      listContextProjects: vi.fn().mockResolvedValue({
        projects: [{ project_id: 'project_atlas', project_name: 'Atlas' }],
      }),
      getContextJson: vi.fn().mockResolvedValue({
        current_task: 'Something a live session recorded after the file was written',
        open_questions: ['Already asked'],
        tech_stack: [],
      }),
    });

    const text = (await runFirstRunImport(client as any, cwd)) || '';

    expect(client.createContextProject).not.toHaveBeenCalled();
    const patch = client.patchProjectContext.mock.calls[0][1];
    expect(patch.current_task).toBeUndefined();
    expect(patch.open_questions).toBeUndefined();
    expect(patch.current_status).toBe('Wiring the new queue');
    expect(patch.tech_stack).toEqual(['TypeScript', 'Postgres']);
    expect(text).toContain('Nothing was overwritten');
    expect(text).toContain('current_task');
    // Extraction REWRITES a brief rather than filling gaps, so it must not run
    // against a project that already answered something.
    expect(client.pushContextUpdate).not.toHaveBeenCalled();
  });

  it('writes nothing at all when the existing context cannot be read', async () => {
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient({
      listContextProjects: vi.fn().mockResolvedValue({
        projects: [{ project_id: 'project_atlas', project_name: 'Atlas' }],
      }),
      getContextJson: vi.fn().mockRejectedValue(new Error('503')),
    });

    // A failed read is not permission to write: a transient error must not be
    // able to cost someone their brief.
    const text = await runFirstRunImport(client as any, cwd);

    expect(client.patchProjectContext).not.toHaveBeenCalled();
    expect(client.pushContextUpdate).not.toHaveBeenCalled();
    expect(text).toBeNull();
    expect(eventNames(client)).toContain('context_import_failed');
    // Nothing was seeded, so the next session gets a clean attempt.
    expect(hasImportedLocalContext(cwd)).toBe(false);
  });

  it('never imports DeerDawn’s own output back into itself', async () => {
    // project-sync writes these blocks INTO the same files. Reading them back as
    // if the user wrote them manufactures context out of nothing.
    const ownOutput = [
      '@.deerdawn-context.md',
      '',
      '<!-- deerdawn:start -->',
      '## DeerDawn Context',
      'Current task: whatever DeerDawn last wrote here',
      'Tech stack:',
      '- TypeScript',
      '<!-- deerdawn:end -->',
    ].join('\n');
    const cwd = makeWorkspace({ 'AGENTS.md': ownOutput, '.cursorrules': ownOutput });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    expect(findLocalContextFile(cwd)).toBeNull();
    expect(await runFirstRunImport(client as any, cwd)).toBeNull();
    expect(client.createContextProject).not.toHaveBeenCalled();
    expect(client.patchProjectContext).not.toHaveBeenCalled();
  });

  it('names the project after the directory when the heading is just the filename', async () => {
    // `# CLAUDE.md` is how most of these files open. The filename strip used to
    // apply to one branch of the name extraction, so the last branch handed back
    // "CLAUDE.md" as the project name — and that name is the key the
    // existing-project lookup uses.
    const cwd = makeWorkspace({ 'CLAUDE.md': `# CLAUDE.md\n\n${USER_CLAUDE_MD.split('\n').slice(2).join('\n')}` });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    await runFirstRunImport(client as any, cwd);

    const [name] = client.createContextProject.mock.calls[0];
    expect(name).toBe(path.basename(cwd));
    expect(name).not.toBe('CLAUDE.md');
  });

  it('does not seed a workspace with no context file', async () => {
    const cwd = makeWorkspace({ 'README.md': 'nothing DeerDawn reads' });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    expect(await runFirstRunImport(client as any, cwd)).toBeNull();
    expect(client.createContextProject).not.toHaveBeenCalled();
  });

  it('holds off when the /active call failed rather than reported emptiness', async () => {
    // "We could not reach the API" must never be read as "there is nothing here".
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient({
      getActiveContextByCwd: vi.fn().mockRejectedValue(new Error('timeout')),
      getContextMap: vi.fn().mockRejectedValue(new Error('timeout')),
    });

    const result = await handleContextSyncTool('start_session', {}, client as any);

    expect(result.content?.[0]?.text || '').toContain('unreachable');
    expect(client.createContextProject).not.toHaveBeenCalled();
  });

  it('never writes the account-wide profile from a project file, attended or not', async () => {
    // The profile is what the person says about themselves, in files about the
    // person (~/.claude/CLAUDE.md, ~/.deerdawn-context.md). A project's CLAUDE.md
    // is a project note: an `About me:` or `Preferences:` line in it stays in
    // the project. Journey round 5, owner decision.
    const cwd = makeWorkspace({
      'CLAUDE.md': `${USER_CLAUDE_MD}\n\nAbout me: Solo founder\nPreferences:\n- be concise\n`,
    });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    await runFirstRunImport(client as any, cwd);
    expect(client.updateGlobalContext).not.toHaveBeenCalled();

    // The confirmed, user-driven import fills the project and still leaves the profile alone.
    resetFirstRunImportState();
    const manual = makeClient();
    await handleContextSyncTool('import_local_context', { confirmed: true }, manual as any);
    expect(manual.patchProjectContext).toHaveBeenCalled();
    expect(manual.updateGlobalContext).not.toHaveBeenCalled();
  });

  it('reports the import through the existing context_import_* funnel only', async () => {
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    await runFirstRunImport(client as any, cwd);

    const names = eventNames(client);
    expect(names).toContain('context_import_started');
    expect(names).toContain('context_import_succeeded');
    // The card said this is wiring, not new instrumentation. Anything outside
    // the four dashboard names is a new event nobody has a chart for.
    const known = ['context_import_viewed', 'context_import_started', 'context_import_succeeded', 'context_import_failed'];
    expect(names.every((n) => known.includes(n))).toBe(true);

    const succeeded = client.recordProductEvent.mock.calls
      .map((call: any[]) => call[0])
      .find((event: any) => event.event_name === 'context_import_succeeded');
    expect(succeeded.metadata).toMatchObject({ trigger: 'auto', file: 'CLAUDE.md', project_existed: false });
  });

  it('emits context_import_viewed for a preview and imports nothing', async () => {
    const cwd = makeWorkspace({ 'CLAUDE.md': USER_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const client = makeClient();

    const result = await handleContextSyncTool('import_local_context', {}, client as any);

    // The preview must say how to accept, through a tool that is advertised.
    expect(result.content?.[0]?.text || '').toContain('confirmed:true');
    expect(eventNames(client)).toEqual(['context_import_viewed']);
    expect(client.createContextProject).not.toHaveBeenCalled();
  });
});

describe('first-run gates', () => {
  it('strips every DeerDawn-authored region and the context pointer', () => {
    const mixed = [
      '@.deerdawn-context.md',
      '# Real project',
      '<!-- deerdawn:auto-context -->',
      'directives DeerDawn wrote',
      '<!-- /deerdawn:auto-context -->',
      'user wrote this',
      '<!-- deerdawn:skills:start -->',
      'skill listing',
      '<!-- deerdawn:skills:end -->',
    ].join('\n');

    const stripped = stripDeerdawnAuthoredBlocks(mixed);
    expect(stripped).toContain('# Real project');
    expect(stripped).toContain('user wrote this');
    expect(stripped).not.toContain('directives DeerDawn wrote');
    expect(stripped).not.toContain('skill listing');
    expect(stripped).not.toContain('@.deerdawn-context.md');
  });

  // Used to assert the opposite: an unterminated block was "ours to the end of
  // the file". A lone marker is as likely to be one an editor left behind, above
  // the person's own sections, and reading it that way cut everything after it
  // out of the import. Only a well-formed pair is DeerDawn's.
  it('does not treat an unterminated DeerDawn block as ours: nothing of the person\'s is cut', () => {
    const truncated = '# Real project\n<!-- deerdawn:start -->\nhalf a block';
    expect(stripDeerdawnAuthoredBlocks(truncated)).toBe(truncated);
  });

  it('prefers CLAUDE_PROJECT_DIR but refuses the string "undefined"', () => {
    const previous = process.env.CLAUDE_PROJECT_DIR;
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-wsdir-')));
    try {
      process.env.CLAUDE_PROJECT_DIR = real;
      expect(resolveWorkspaceDir()).toBe(real);

      // `process.env.X = undefined` stores the literal string, which used to be
      // able to out-vote a perfectly good cwd.
      process.env.CLAUDE_PROJECT_DIR = 'undefined';
      expect(resolveWorkspaceDir('/fallback')).toBe('/fallback');

      process.env.CLAUDE_PROJECT_DIR = path.join(real, 'does-not-exist');
      expect(resolveWorkspaceDir('/fallback')).toBe('/fallback');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previous;
    }
  });
});

/**
 * DeerDawn's own instructions, written by the USER.
 *
 * The marked-region strip only covers what project-sync wrote. It never covered
 * the block the user pasted off our setup page into their own CLAUDE.md, which
 * sits outside every marker — so it read as theirs, went through extraction, and
 * became the first thing a new user ever saw DeerDawn remember: our own
 * directives, quoted back at them, in place of their project.
 *
 * The tests that matter most here are the ones asserting it does NOT fire. The
 * two errors are not symmetric: a leftover line of boilerplate is a blemish, and
 * eating a paragraph someone wrote about their own project is silent data loss
 * in the product that must not lose what it is handed.
 */
describe('user-pasted DeerDawn boilerplate', () => {
  const PROJECT_PROSE = [
    '# Atlas',
    '',
    'Current task: Ship the ingest rewrite',
    '',
    '## Architecture',
    '',
    'The ingest worker reads from Kafka and writes batches into Postgres. The old',
    'batch importer is still wired up behind a flag nobody has removed.',
  ].join('\n');

  it('removes the published block a user pasted under its own heading', () => {
    const pasted = buildDeerdawnInstructionLines().join('\n');
    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${pasted}\n`);

    expect(stripped).toContain('Ship the ingest rewrite');
    expect(stripped).toContain('reads from Kafka');
    expect(stripped).not.toContain('start_session');
    expect(stripped).not.toContain('build_subagent_brief');
    // The heading goes too, once nothing is left under it.
    expect(stripped).not.toMatch(/^##\s+DeerDawn\s*$/m);
  });

  it('removes an adapted version — renamed heading, renumbered, sentences trimmed', () => {
    // What DeerDawn's own repo carries. Nobody pasted this verbatim: the heading
    // is different, the lines are a numbered list, and two of our sentences have
    // had their last clause cut off. It is still our block.
    const adapted = [
      '## DeerDawn Context Network',
      '',
      'Use DeerDawn MCP as the primary context source.',
      '',
      '1. Call `start_session` first.',
      '2. For targeted context, call `get_context(project_id, sections=["task"])`.',
      '3. Before repo-wide search, call `get_project_map` and `find_known_paths`.',
      '4. Use DeerDawn before repo search for orientation.',
      '5. Use repo search only when you need file-level or symbol-level resolution.',
      '6. Write meaningful changes back with `update_context(project_id, summary)`.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${adapted}\n`);
    expect(stripped).toContain('reads from Kafka');
    expect(stripped).not.toContain('DeerDawn Context Network');
    expect(stripped).not.toContain('get_project_map');
  });

  it('removes pasted lines that were never given a heading', () => {
    const lines = buildDeerdawnInstructionLines();
    const loose = [
      '# Atlas',
      '',
      lines[1],
      lines[3],
      '',
      'The ingest worker reads from Kafka and writes batches into Postgres.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(loose);
    expect(stripped).toContain('# Atlas');
    expect(stripped).toContain('reads from Kafka');
    expect(stripped).not.toContain('start_session');
  });

  it('keeps a line where the user glued their own instruction onto ours', () => {
    // This repo's own AGENTS.md, line 34. Two published sentences with the
    // author's own imperative in front of them. Reaching the boilerplate by
    // deleting the line would take their instruction with it, and their
    // instruction is the part we exist to preserve.
    const glued = '**Never narrate context back.** Use DeerDawn before repo search for orientation and known paths. '
      + 'Use repo search only when you need file-level or symbol-level resolution DeerDawn does not yet know.';

    expect(stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${glued}\n`)).toContain('Never narrate context back');
  });

  it('keeps a section the user wrote about their own DeerDawn integration', () => {
    // Names DeerDawn in the heading, four lines long, and entirely theirs: these
    // are facts about their code, not instructions copied from ours.
    const theirs = [
      '## DeerDawn integration',
      '',
      'We push a brief from the nightly ETL job once the warehouse load finishes.',
      'The webhook lives in services/sync/webhook.ts and retries three times.',
      'Staging has never been wired up, so staging briefs are empty on purpose.',
      'If the load runs long the brief lands after standup, which defeats the point.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${theirs}\n`);
    expect(stripped).toContain('## DeerDawn integration');
    expect(stripped).toContain('services/sync/webhook.ts');
    expect(stripped).toContain('defeats the point');
  });

  it('keeps a short note about operating the tools', () => {
    // Tool names, under a DeerDawn heading, but two lines — an aside somebody
    // wrote, not a block anybody pasted.
    const note = [
      '## DeerDawn',
      '',
      'We call start_session from the CI wrapper, not from the agent.',
      'manage_tasks is off for this repo — the board lives in Linear.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${note}\n`);
    expect(stripped).toContain('the board lives in Linear');
    expect(stripped).toContain('CI wrapper');
  });

  it('keeps a block that carries real project facts alongside the boilerplate', () => {
    // One copied line, but most of the section is about their repo. Below the
    // density gate, so the section is theirs and survives whole — including the
    // copied line, which is the trade this heuristic deliberately makes.
    const mixed = [
      '## DeerDawn notes',
      '',
      'Use DeerDawn before repo search for orientation and known paths.',
      'Our project id is project_atlas — it is pinned in .env.local, do not change it.',
      'The ingest worker and the API are two separate DeerDawn projects.',
      'Ask Priya before renaming anything; the dashboards key off the old names.',
      'Migrations live in db/migrations and are applied by the deploy job.',
      'The staging account is shared with the data team.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${mixed}\n`);
    expect(stripped).toContain('## DeerDawn notes');
    expect(stripped).toContain('Ask Priya before renaming anything');
    expect(stripped).toContain('db/migrations');
  });

  it('judges a subsection on its own merits instead of sweeping it up', () => {
    // A section ends at the next heading of ANY level, so the project's own facts
    // nested under a DeerDawn heading are not collateral.
    const nested = [
      '## DeerDawn Context Network',
      '',
      'Use DeerDawn MCP as the primary context source.',
      '1. Call `start_session` first.',
      '2. Before repo-wide search, call `get_project_map` and `find_known_paths`.',
      '3. Use DeerDawn before repo search for orientation.',
      '4. Use repo search only when you need file-level or symbol-level resolution.',
      '',
      '### Repo structure',
      '',
      'The map lives in docs/repo-map.md. Append a node, never rewrite the tree.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(nested);
    expect(stripped).not.toContain('DeerDawn Context Network');
    expect(stripped).toContain('### Repo structure');
    expect(stripped).toContain('docs/repo-map.md');
  });

  it('leaves a file with no DeerDawn boilerplate byte-for-byte alone', () => {
    expect(stripDeerdawnBoilerplate(USER_CLAUDE_MD)).toBe(USER_CLAUDE_MD);
  });

  it('leaves a heading the user deliberately left bare', () => {
    const bare = '# Atlas\n\n## DeerDawn\n\n## Deploy\n\nRun make ship from a clean tree.';
    expect(stripDeerdawnBoilerplate(bare)).toContain('## DeerDawn');
  });

  it('a file that is nothing but our instructions is not an import at all', () => {
    // The end of the loop this exists to close: with the boilerplate gone the
    // file falls under the user-authored floor, so no project is seeded from a
    // brief whose entire content is DeerDawn's setup page.
    const cwd = makeWorkspace({ 'CLAUDE.md': `${buildDeerdawnInstructionLines().join('\n')}\n` });
    process.env.CLAUDE_PROJECT_DIR = cwd;

    expect(readUserAuthoredContext(path.join(cwd, 'CLAUDE.md'))).toBeNull();
    expect(findLocalContextFile(cwd)).toBeNull();
  });

  it('imports the project half of a file that carries both', async () => {
    const cwd = makeWorkspace({
      'CLAUDE.md': `${USER_CLAUDE_MD}\n\n${buildDeerdawnInstructionLines().join('\n')}\n`,
    });
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const previousAutoImport = process.env.DEERDAWN_AUTO_IMPORT;
    process.env.DEERDAWN_AUTO_IMPORT = '1'; // the user's opt-in; consent is pinned elsewhere
    const client = makeClient();

    try {
    await runFirstRunImport(client as any, cwd);

    const pushed = client.pushContextUpdate.mock.calls.map((call: any[]) => String(call[1] || '')).join('\n');
    const patched = JSON.stringify(client.patchProjectContext.mock.calls);
    expect(`${pushed}\n${patched}`).toContain('ingest rewrite');
    expect(pushed).not.toContain('start_session');
    expect(patched).not.toContain('start_session');
    } finally {
      if (previousAutoImport === undefined) delete process.env.DEERDAWN_AUTO_IMPORT;
      else process.env.DEERDAWN_AUTO_IMPORT = previousAutoImport;
    }
  });
});

/**
 * The same block under a heading that does not say "DeerDawn".
 *
 * The heading used to be a required clause, which made the one part of a pasted
 * block that people reliably rewrite into the one part that decided the outcome.
 * Renaming it to "## Session Memory" walked the whole block past the section
 * rule, and the line pass then removed only the sentences still verbatim — so a
 * user's first brief was a half-eaten copy of our setup page with the numbering
 * shot through it.
 *
 * As above, the tests that matter most are the ones asserting it does NOT fire.
 * Widening the catch is exactly the direction that can start eating what someone
 * wrote about their own project, so each keep-case below names the signal that
 * saves it.
 */
describe('DeerDawn boilerplate under a heading that does not name us', () => {
  const PROJECT_PROSE = [
    '# Atlas',
    '',
    'Current task: Ship the ingest rewrite',
    '',
    '## Architecture',
    '',
    'The ingest worker reads from Kafka and writes batches into Postgres. The old',
    'batch importer is still wired up behind a flag nobody has removed.',
  ].join('\n');

  it('removes our block when the heading was renamed', () => {
    const renamed = [
      '## Session Memory',
      '',
      'Use DeerDawn MCP as the primary context source.',
      '',
      '1. Call `start_session` first.',
      '2. Before repo-wide search, call `get_project_map` and `find_known_paths`.',
      '3. Use DeerDawn before repo search for orientation.',
      '4. Write meaningful changes back with `update_context(project_id, summary)`.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${renamed}\n`);

    expect(stripped).toContain('reads from Kafka');
    expect(stripped).not.toContain('Session Memory');
    expect(stripped).not.toContain('start_session');
    expect(stripped).not.toContain('get_project_map');
    // The failure this closes was not "some of it stayed" — it was that the line
    // pass left a mangled remnant behind, numbering and all.
    expect(stripped).not.toMatch(/^\s*\d\./m);
  });

  it('removes a version retyped in the user\'s own words, with nothing left to match', () => {
    // No sentence here is a copy of ours, so descendsFromPublishedLine finds
    // nothing and the heading names nothing. What settles it is that every
    // identifier in the section is one of our tool names.
    const retyped = [
      '## Memory Protocol',
      '',
      'Kick things off with `start_session` so the brief loads.',
      'Ask `recall(action:"map")` for layout instead of grepping around.',
      'Push anything decided through `manage_memory` right away.',
      'Cards live on `manage_tasks`; move them, don\'t keep a side list.',
      'Hand subagents a `build_subagent_brief` and nothing else.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${retyped}\n`);

    expect(stripped).toContain('reads from Kafka');
    expect(stripped).not.toContain('Memory Protocol');
    expect(stripped).not.toContain('manage_tasks');
    expect(stripped).not.toContain('build_subagent_brief');
  });

  it('keeps a runbook that happens to mention a tool — saved by the tool count', () => {
    // Four lines, high density, neutral heading: the only thing standing between
    // this and deletion is that one tool name is not a tour of the tool surface.
    const runbook = [
      '## Deploy runbook',
      '',
      'Deploys go out via `make ship` from main only.',
      'The migration step needs `DATABASE_URL` pointed at the primary, not the replica.',
      'After a deploy, record the release SHA with `manage_memory` so the next session has it.',
      'Rollback is `make ship-rollback SHA=<previous>`; it does not undo migrations.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${runbook}\n`);

    expect(stripped).toContain('## Deploy runbook');
    expect(stripped).toContain('make ship-rollback');
    expect(stripped).toContain('does not undo migrations');
  });

  it('keeps a wrapper\'s notes about the tools it calls — saved by saturation', () => {
    // Six of our tool names, neutral heading, no copied sentence. This is the
    // case the tool-count gate alone would eat, and the reason provenance asks
    // whether anything of THEIRS is named too: half this section's identifiers
    // are the author's own, so it is theirs.
    const wrapper = [
      '## Sync worker',
      '',
      '`src/sync/worker.ts` calls `start_session` on boot and caches the brief in `redis`.',
      '`src/sync/flush.ts` batches `manage_memory` writes every 30s — see `FLUSH_INTERVAL_MS`.',
      'The `recall(action:"map")` response is memoised in `src/sync/cache.ts` for an hour.',
      '`manage_tasks` is proxied through `src/sync/board.ts` because of the rate limit.',
      'If `build_subagent_brief` 500s we fall back to `src/sync/fallback.ts` and log loudly.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${wrapper}\n`);

    expect(stripped).toContain('## Sync worker');
    expect(stripped).toContain('src/sync/worker.ts');
    expect(stripped).toContain('FLUSH_INTERVAL_MS');
    expect(stripped).toContain('log loudly');
  });

  it('keeps prose about our tools that names no identifiers at all', () => {
    // No code spans, so saturation abstains rather than guessing — a section with
    // nothing to measure is not evidence, and the user keeps their paragraph.
    const prose = [
      '## How we use session memory',
      '',
      'We only turn start_session on for the two repos that have a real brief.',
      'The rest of the team found manage_memory noisy and switched it off in March.',
      'Priya owns the decision to re-enable it; ask her before changing manage_tasks.',
      'Nobody has ever used build_subagent_brief here and we are fine with that.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(`${PROJECT_PROSE}\n\n${prose}\n`);

    expect(stripped).toContain('## How we use session memory');
    expect(stripped).toContain('Priya owns the decision');
    expect(stripped).toContain('switched it off in March');
  });

  it('leaves a bare heading alone but clears one it emptied', () => {
    // Pass 3 no longer consults the name either. What keeps it honest is that the
    // section must have HAD a body and all of it must have been ours.
    const mixed = [
      '# Atlas',
      '',
      '## Later',
      '',
      '## Context rules',
      '',
      ...buildDeerdawnInstructionLines().slice(1, 5),
      '',
      '## Deploy',
      '',
      'Run make ship from a clean tree.',
    ].join('\n');

    const stripped = stripDeerdawnBoilerplate(mixed);

    expect(stripped).toContain('## Later');
    expect(stripped).toContain('## Deploy');
    expect(stripped).toContain('Run make ship from a clean tree.');
    expect(stripped).not.toContain('## Context rules');
    expect(stripped).not.toContain('start_session');
  });

  // The repo's CLAUDE.md is private (the public export does not ship it).
  const REPO_CLAUDE_MD = new URL('../../../CLAUDE.md', import.meta.url);
  it.skipIf(!fs.existsSync(REPO_CLAUDE_MD))('keeps this repo\'s own project sections when stripping its CLAUDE.md (skipped where CLAUDE.md is not in this checkout: private repo only)', () => {
    // The real file, as the regression case: it opens with a DeerDawn section
    // whose "### Repo structure" subsection is genuinely about the repo, and
    // several later sections are dense with our own names because the product IS
    // DeerDawn. Widening the section rule must not reach any of them.
    const repoClaudeMd = fs.readFileSync(REPO_CLAUDE_MD, 'utf8');

    const stripped = stripDeerdawnBoilerplate(stripDeerdawnAuthoredBlocks(repoClaudeMd));

    expect(stripped).not.toContain('DeerDawn Context Network');
    expect(stripped).not.toContain('`start_session` first');
    // Its own facts, all of them still there.
    expect(stripped).toContain('### Repo structure: explore once, append forever');
    expect(stripped).toContain('docs/repo-map.md');
    expect(stripped).toContain('## Monorepo Structure');
    expect(stripped).toContain('apps/api` — Context sync API');
    expect(stripped).toContain('## Context Sync API Routes');
    expect(stripped).toContain('## Key Files');
    expect(stripped).toContain('## Module Boundaries');
    expect(stripped).toContain('make verify-prod');
  });

  it('a renamed-heading block is not an import either', () => {
    // The end of the same loop the DeerDawn-headed case closes: with the block
    // gone the file falls under the user-authored floor, so no project is seeded
    // whose entire brief is our setup page under a heading we did not write.
    const body = buildDeerdawnInstructionLines().slice(1).join('\n');
    const cwd = makeWorkspace({ 'CLAUDE.md': `## Session Memory\n\n${body}\n` });
    process.env.CLAUDE_PROJECT_DIR = cwd;

    expect(readUserAuthoredContext(path.join(cwd, 'CLAUDE.md'))).toBeNull();
    expect(findLocalContextFile(cwd)).toBeNull();
  });
});
