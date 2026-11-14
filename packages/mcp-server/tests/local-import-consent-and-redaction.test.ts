import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleContextSyncTool, runFirstRunImport } from '../src/tools/context-sync.js';
import {
  autoImportOptIn,
  readUserAuthoredContext,
  resetFirstRunImportState,
} from '../src/first-run-import.js';

/**
 * CLAUDE.md went to the server unredacted, and nobody was asked.
 *
 * Two halves, and they fail in opposite directions:
 *
 *   REDACTION. Every other capture path masks secrets before anything leaves
 *   the machine — the Stop-hook transcript does, captured shell commands do and
 *   say so. The local import did not. A CLAUDE.md with a connection string or a
 *   pasted key in it was read, parsed into structured fields and pushed to
 *   /extraction verbatim, where it is also forwarded to the LLM subprocessor.
 *   This is the one file in a repo people most often keep a working DATABASE_URL
 *   in, because it is the file they paste their setup notes into.
 *
 *   CONSENT. runFirstRunImport uploaded that file on the FIRST start_session in
 *   a workspace, unprompted. The problem it was built to solve was real — the
 *   old "run import_local" tip went to stderr, which is the server's log and not
 *   the conversation, so it reached nobody. But invisibility and consent are
 *   different problems, and uploading the file solved the first by giving away
 *   the second. The fix keeps the visibility and returns the choice: the offer
 *   is rendered IN the conversation, and the upload happens when the user says
 *   so (or has opted in once, for good).
 */

const TOUCHED_ENV = ['DEERDAWN_HOME', 'CLAUDE_PROJECT_DIR', 'DEERDAWN_AUTO_IMPORT'] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of TOUCHED_ENV) ORIGINAL_ENV[key] = process.env[key];

const SECRET_CLAUDE_MD = [
  '# Atlas',
  '',
  'Current task: Ship the ingest rewrite',
  'Current status: Wiring the new queue',
  '',
  '## Environment',
  '',
  'DATABASE_URL=postgres://atlas:hunter2isnotgreat@db.internal:5432/atlas',
  'OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  '',
  'Atlas replaced the batch importer with a streaming one last quarter, and the remaining work is',
  'mostly draining the old queue without dropping partially written rows on the floor.',
].join('\n');

function makeWorkspace(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-consent-')));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }
  return dir;
}

function makeClient(overrides: Record<string, any> = {}) {
  return {
    flushQueuedContextWrites: vi.fn().mockResolvedValue(null),
    getActiveContextByCwd: vi.fn().mockResolvedValue(null),
    getContextMap: vi.fn().mockResolvedValue({ map: '[DeerDawn]' }),
    listContextProjects: vi.fn().mockResolvedValue({ projects: [] }),
    createContextProject: vi.fn().mockResolvedValue({
      project: { project_id: 'proj_atlas', project_name: 'Atlas' },
    }),
    getContextJson: vi.fn().mockResolvedValue({ context: {} }),
    patchProjectContext: vi.fn().mockResolvedValue({}),
    pushContextUpdate: vi.fn().mockResolvedValue({}),
    updateGlobalContext: vi.fn().mockResolvedValue({}),
    recordProductEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Everything this client would have put on the wire, as one string. */
function wireTraffic(client: any): string {
  const calls: unknown[] = [];
  for (const fn of [client.patchProjectContext, client.pushContextUpdate, client.updateGlobalContext]) {
    for (const call of fn?.mock?.calls ?? []) calls.push(call);
  }
  return JSON.stringify(calls);
}

describe('local context import: consent and redaction', () => {
  let home: string;
  let workspace: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-consent-home-')));
    process.env.DEERDAWN_HOME = home;
    delete process.env.DEERDAWN_AUTO_IMPORT;
    workspace = makeWorkspace({ 'CLAUDE.md': SECRET_CLAUDE_MD });
    process.env.CLAUDE_PROJECT_DIR = workspace;
    resetFirstRunImportState();
  });

  afterEach(() => {
    for (const key of TOUCHED_ENV) {
      if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL_ENV[key];
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    resetFirstRunImportState();
  });

  describe('redaction', () => {
    it('masks secrets out of the file before anything reads it', () => {
      const body = readUserAuthoredContext(path.join(workspace, 'CLAUDE.md')) || '';
      expect(body, 'the prose the user wrote must survive').toContain('draining the old queue');
      expect(body).not.toContain('hunter2isnotgreat');
      expect(body).not.toContain('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
      expect(body).toContain('[REDACTED]');
    });

    it('sends no secret from CLAUDE.md to the server on a confirmed import', async () => {
      const client = makeClient();
      await handleContextSyncTool('import_local_context', { confirmed: true }, client as any);
      const wire = wireTraffic(client);
      expect(wire).not.toContain('hunter2isnotgreat');
      expect(wire).not.toContain('sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    });

    it('does not show the secret back in the preview either', async () => {
      const client = makeClient();
      const result = await handleContextSyncTool('import_local_context', {}, client as any);
      const text = result.content.map((c) => c.text).join('\n');
      expect(text).not.toContain('hunter2isnotgreat');
    });
  });

  describe('consent', () => {
    it('is off unless the user turned it on', () => {
      expect(autoImportOptIn()).toBe(false);
    });

    it('does not upload a file nobody chose to send', async () => {
      const client = makeClient();
      const text = await runFirstRunImport(client as any, workspace);

      expect(client.patchProjectContext, 'first run must not upload CLAUDE.md unasked').not.toHaveBeenCalled();
      expect(client.pushContextUpdate).not.toHaveBeenCalled();
      expect(client.createContextProject).not.toHaveBeenCalled();

      // The visibility half of the original fix is kept: the offer is rendered
      // in the CONVERSATION, naming the file and the one call that accepts it.
      expect(text, 'a silent no-op is how the stderr tip reached nobody').toBeTruthy();
      expect(text).toContain('CLAUDE.md');
      expect(text).toMatch(/import_local/);
    });

    it('imports when the user has opted in', async () => {
      process.env.DEERDAWN_AUTO_IMPORT = '1';
      expect(autoImportOptIn()).toBe(true);
      const client = makeClient();
      await runFirstRunImport(client as any, workspace);
      expect(client.patchProjectContext).toHaveBeenCalled();
      const wire = wireTraffic(client);
      expect(wire, 'opting in to the import is not opting in to leaking a key').not.toContain('hunter2isnotgreat');
    });

    it('takes the opt-in from ~/.deerdawn/config.json too', async () => {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ auto_import_local: true }), 'utf8');
      expect(autoImportOptIn()).toBe(true);
    });

    it('offers again next session rather than recording a seed that never happened', async () => {
      const client = makeClient();
      await runFirstRunImport(client as any, workspace);
      resetFirstRunImportState();
      const second = await runFirstRunImport(client as any, workspace);
      expect(second, 'declining once must not mark the workspace as imported').toBeTruthy();
    });

    it('names a tool the client can actually see as the way to accept', async () => {
      // The offer sends the user to manage_memory(action:"import_local"), and
      // the preview that call returns told them to confirm with
      // `import_local_context` — dispatchable, but not in tools/list, so on a
      // client that only calls what is advertised the second step of the consent
      // flow was a tool that does not exist. Followed end to end, as offered:
      const client = makeClient();
      const preview = await handleContextSyncTool('manage_memory', { action: 'import_local' }, client as any);
      const text = preview.content.map((c) => c.text).join('\n');

      expect(text).toContain('manage_memory(action:"import_local", confirmed:true)');
      expect(text).not.toContain('import_local_context');
      expect(client.patchProjectContext, 'a preview uploads nothing').not.toHaveBeenCalled();

      await handleContextSyncTool('manage_memory', { action: 'import_local', confirmed: true }, client as any);
      expect(client.patchProjectContext, 'the call the preview names must be the one that imports').toHaveBeenCalled();
    });

    it('still lets the user ask for the import explicitly', async () => {
      const client = makeClient();
      const result = await handleContextSyncTool('import_local_context', { confirmed: true }, client as any);
      expect(client.patchProjectContext).toHaveBeenCalled();
      expect(result.content.map((c) => c.text).join('\n')).toMatch(/Imported/);
    });
  });
});
