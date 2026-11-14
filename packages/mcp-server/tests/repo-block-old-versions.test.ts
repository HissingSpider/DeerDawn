import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildContextPointer, syncProjectFiles } from '../src/project-sync.js';

/**
 * A USER ON AN OLDER PUBLISHED VERSION KEEPS GETTING THEIR REPO FILES REFRESHED.
 *
 * A sync that names no tool (a boot, start_session) refreshes a tool's file only
 * if it already carries DeerDawn's block. So every form an older version wrote
 * has to be recognised as DeerDawn's. The history of project-sync.ts
 * (`git log -p -S'deerdawn:' -- packages/mcp-server/src`) has exactly these:
 *
 *   - the context block, `<!-- deerdawn:start -->` ... `<!-- deerdawn:end -->`,
 *     since the first version (2026-05-29, cb1bcd09), prepended to AGENTS.md,
 *     .cursorrules and .github/copilot-instructions.md, with the whole brief
 *     inside (2026-05-29), then a thin pointer (server-side custody,
 *     2026-06-08, e0043b31), then the current pointer;
 *   - the skills index block, `<!-- deerdawn:skills:start -->` ...
 *     `<!-- deerdawn:skills:end -->`, since 2026-06-27 (942d1a35);
 *   - the CLAUDE.md pointer line `@.deerdawn-context.md`, and the context file
 *     .deerdawn-context.md (the brief, then the pointer), since the first version.
 *
 * No marker was ever reworded, so each old form IS the current form and is
 * refreshed in place. Each case below seeds a file exactly as that version wrote
 * it and checks the person's own text is untouched.
 */

const START = '<!-- deerdawn:start -->';
const END = '<!-- deerdawn:end -->';
const SKILLS_START = '<!-- deerdawn:skills:start -->';
const SKILLS_END = '<!-- deerdawn:skills:end -->';
const LAST_UPDATED = '2026-09-28T00:00:00.000Z';
const USER = '# Project rules\n\nUse pnpm. Never force-push.\n';

// What each version put inside the block.
const V1_BRIEF = 'Project: Atlas | Synced: 2026-05-29 05:00 UTC\n\nCurrent task: ship the queue\nDecisions:\n- Use NATS';
const V_CUSTODY_POINTER = [
  'Project: Atlas',
  '',
  "This project's working context — current task, recent decisions, tech stack,",
  'open questions, and where you left off — is maintained live by DeerDawn and',
  'delivered into your session at start. It is intentionally NOT written to disk.',
  '',
  'Run `start_session` (DeerDawn MCP) to load the current brief. Without a live',
  'DeerDawn connection this file is only a pointer — the context lives server-side.',
  'Last synced: 2026-06-08T00:00:00.000Z',
].join('\n');
const FULL_BRIEF_WITH_OPEN_FENCE = `${V1_BRIEF}\n\n\`\`\`sh\nmake ship   # the brief was cut here, inside a code fence`;

let repo: string;

function client() {
  return {
    getActiveContextByCwd: vi.fn().mockResolvedValue({ brief: 'Project: Atlas', project_name: 'Atlas', project_id: 'proj-1', match_kind: 'path', last_updated: LAST_UPDATED, context: { tech_stack: [] } }),
    getContextJson: vi.fn().mockResolvedValue({ tech_stack: [] }),
    patchProjectContext: vi.fn().mockResolvedValue(undefined),
    upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue([]),
  } as any;
}
const write = (rel: string, text: string) => {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(repo, rel));
const current = (eol = '\n') => [START, '## DeerDawn Context', '', buildContextPointer('Atlas', LAST_UPDATED), END].join('\n').replace(/\n/g, eol);

/** What a version wrote: its block prepended to the person's text (how every version put it). */
const prepended = (inner: string, user = USER) => `${START}\n## DeerDawn Context\n\n${inner}\n${END}\n\n${user}`;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-old-versions-')));
  fs.mkdirSync(path.join(repo, '.git'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

const FILES = ['AGENTS.md', '.cursorrules', '.github/copilot-instructions.md'];

describe('the context block, as each version wrote it, in each tool\'s file', () => {
  const FORMS: Array<[string, string]> = [
    ['2026-05-29: the whole brief inside', V1_BRIEF],
    ['2026-06-08: the custody pointer', V_CUSTODY_POINTER],
    ['the brief cut inside a code fence', FULL_BRIEF_WITH_OPEN_FENCE],
    ['the current pointer', buildContextPointer('Atlas', '2026-09-01T00:00:00.000Z')],
  ];

  for (const rel of FILES) {
    for (const [label, inner] of FORMS) {
      it(`${rel}, ${label}: refreshed in place by a sync that names no tool, the person's text untouched, no other tool's file added`, async () => {
        write(rel, prepended(inner));

        await syncProjectFiles(client(), repo);
        const once = read(rel);
        await syncProjectFiles(client(), repo);

        expect(once).toBe(`${current()}\n\n${USER}`);
        expect(read(rel)).toBe(once);
        for (const other of FILES.filter((file) => file !== rel)) expect(exists(other)).toBe(false);
        expect(exists('CLAUDE.md')).toBe(false);
      });
    }
  }

  it('a block the person moved below their own text is refreshed where it is', async () => {
    write('AGENTS.md', `${USER}\n${START}\n## DeerDawn Context\n\n${V1_BRIEF}\n${END}\n\n## Later\nKeep answers short.\n`);

    await syncProjectFiles(client(), repo);

    expect(read('AGENTS.md')).toBe(`${USER}\n${current()}\n\n## Later\nKeep answers short.\n`);
  });

  it('a CRLF file (a Windows checkout): the block is found and refreshed, the person\'s lines keep their endings', async () => {
    const userCrlf = USER.replace(/\n/g, '\r\n');
    write('AGENTS.md', `${START}\r\n## DeerDawn Context\r\n\r\n${V1_BRIEF.replace(/\n/g, '\r\n')}\r\n${END}\r\n\r\n${userCrlf}`);

    await syncProjectFiles(client(), repo);

    expect(read('AGENTS.md')).toBe(`${current('\r\n')}\r\n\r\n${userCrlf}`);
  });
});

describe('the skills block (2026-06-27 on)', () => {
  it('an AGENTS.md with the context block and the skills block: both are refreshed, and the skills index follows the current list', async () => {
    const skill = { skill_id: 's1', slug: 'deploy-runbook', name: 'Deploy runbook', description: 'How we ship', visibility: 'shared', enabled: true };
    const c = client();
    c.listSkills = vi.fn().mockResolvedValue([skill]);
    c.getSkill = vi.fn().mockResolvedValue({ ...skill, markdown_content: '# Deploy' });
    write('AGENTS.md', `${prepended(V1_BRIEF, '')}${SKILLS_START}\nOLD SKILLS INDEX\n${SKILLS_END}\n\n${USER}`);

    await syncProjectFiles(c, repo);

    const after = read('AGENTS.md');
    expect(after).toContain(buildContextPointer('Atlas', LAST_UPDATED));
    expect(after).not.toContain(V1_BRIEF);
    expect(after).toContain('Deploy runbook');
    expect(after).not.toContain('OLD SKILLS INDEX');
    expect(after.endsWith(USER)).toBe(true);
  });
});

describe('the Claude Code files (the first version on)', () => {
  it('a CLAUDE.md with the pointer line and a context file holding the old brief: the context file is refreshed, CLAUDE.md is not touched', async () => {
    write('CLAUDE.md', `@.deerdawn-context.md\n\n${USER}`);
    write('.deerdawn-context.md', `${V1_BRIEF}\n`);

    await syncProjectFiles(client(), repo);

    expect(read('.deerdawn-context.md')).toBe(`${buildContextPointer('Atlas', LAST_UPDATED)}\n`);
    expect(read('CLAUDE.md')).toBe(`@.deerdawn-context.md\n\n${USER}`);
  });

  it('a context file from the custody version, with no CLAUDE.md pointer left: still refreshed, never re-linked', async () => {
    write('.deerdawn-context.md', `${V_CUSTODY_POINTER}\n`);

    await syncProjectFiles(client(), repo);

    expect(read('.deerdawn-context.md')).toBe(`${buildContextPointer('Atlas', LAST_UPDATED)}\n`);
    expect(exists('CLAUDE.md')).toBe(false);
  });
});
