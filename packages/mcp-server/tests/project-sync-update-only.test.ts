import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { syncProjectFiles } from '../src/project-sync.js';

/**
 * A BOOT OR start_session UPDATES A TOOL'S FILE IN THE REPO ONLY IF THAT FILE
 * ALREADY CARRIES DEERDAWN'S BLOCK.
 *
 * Project sync ran on every boot and every start_session and wrote every tool's
 * file into the repository: CLAUDE.md, AGENTS.md, .cursorrules, the Copilot file,
 * and the shared skills into .claude/skills, .cursor/rules and the AGENTS.md
 * index. A person who uses one tool got the other tools' files in their working
 * tree, unasked. Now a sync that names no tool refreshes a file that already
 * carries DeerDawn's block and creates nothing. Full setup for a chosen tool
 * (`tools`) still writes that tool's files. Shared skills follow the same rule.
 *
 * Everything runs in a temp repo, under the contained HOME
 * (tests/setup/contain-home.ts), with a mocked API.
 */

const START = '<!-- deerdawn:start -->';
const END = '<!-- deerdawn:end -->';
const SKILLS_START = '<!-- deerdawn:skills:start -->';
const SKILLS_END = '<!-- deerdawn:skills:end -->';
const OLD_BLOCK = `${START}\n## DeerDawn Context\n\nOLD POINTER\n${END}`;
const OLD_SKILLS = `${SKILLS_START}\nOLD INDEX\n${SKILLS_END}`;
const MINE = '# My rules\n\nUse pnpm.\n';

let repo: string;

const skill = { skill_id: 's1', slug: 'deploy-runbook', name: 'Deploy runbook', description: 'How we ship', visibility: 'shared', enabled: true };
function client(skills: any[] = []) {
  return {
    getActiveContextByCwd: vi.fn().mockResolvedValue({ brief: 'Project: Atlas', project_name: 'Atlas', project_id: 'proj-1', match_kind: 'path', last_updated: '2026-09-28T00:00:00.000Z', context: { tech_stack: [] } }),
    getContextJson: vi.fn().mockResolvedValue({ tech_stack: [] }),
    patchProjectContext: vi.fn().mockResolvedValue(undefined),
    upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
    listSkills: vi.fn().mockResolvedValue(skills),
    getSkill: vi.fn(async () => ({ ...skill, markdown_content: '# Deploy\n\nRun make ship.' })),
  } as any;
}

const write = (rel: string, text: string) => {
  const file = path.join(repo, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const exists = (rel: string) => fs.existsSync(path.join(repo, rel));

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(repo, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(repo);
  return out;
}

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-update-only-')));
  fs.mkdirSync(path.join(repo, '.git'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('a sync that names no tool (a boot, start_session)', () => {
  it('in a repo that carries nothing of DeerDawn\'s: writes no file at all, and still answers with the project', async () => {
    const name = await syncProjectFiles(client([skill]), repo);

    expect(name).toBe('Atlas');
    expect(snapshot()).toEqual({});
  });

  it('files that carry no DeerDawn block are left byte for byte, and no other tool\'s file appears', async () => {
    write('CLAUDE.md', MINE);
    write('AGENTS.md', MINE);
    write('.cursorrules', MINE);
    write('.github/copilot-instructions.md', MINE);
    const before = snapshot();

    await syncProjectFiles(client([skill]), repo);

    expect(snapshot()).toEqual(before);
  });

  it('a file that carries the block is refreshed, and the tools\' files that do not are not created', async () => {
    write('AGENTS.md', `${OLD_BLOCK}\n\n${MINE}`);

    await syncProjectFiles(client(), repo);

    expect(read('AGENTS.md')).not.toContain('OLD POINTER');
    expect(read('AGENTS.md')).toContain('Project: Atlas');
    expect(read('AGENTS.md')).toContain(MINE);
    expect(exists('.cursorrules')).toBe(false);
    expect(exists('CLAUDE.md')).toBe(false);
    expect(exists('.deerdawn-context.md')).toBe(false);
  });

  it('.cursorrules and the Copilot file are refreshed the same way, each only when it carries the block', async () => {
    write('.cursorrules', `${OLD_BLOCK}\n\n${MINE}`);
    write('.github/copilot-instructions.md', MINE);
    const copilotBefore = read('.github/copilot-instructions.md');

    await syncProjectFiles(client(), repo);

    expect(read('.cursorrules')).not.toContain('OLD POINTER');
    expect(read('.github/copilot-instructions.md')).toBe(copilotBefore);
    expect(exists('AGENTS.md')).toBe(false);
  });

  it('CLAUDE.md that carries the pointer gets its context file refreshed; CLAUDE.md without it is not given one', async () => {
    write('CLAUDE.md', `@.deerdawn-context.md\n\n${MINE}`);
    await syncProjectFiles(client(), repo);
    expect(read('.deerdawn-context.md')).toContain('Project: Atlas');
    expect(read('CLAUDE.md')).toBe(`@.deerdawn-context.md\n\n${MINE}`);

    fs.rmSync(path.join(repo, '.deerdawn-context.md'));
    write('CLAUDE.md', MINE);
    await syncProjectFiles(client(), repo);
    expect(exists('.deerdawn-context.md')).toBe(false);
    expect(read('CLAUDE.md')).toBe(MINE);
  });

  it('an existing context file is kept current even beside a CLAUDE.md with no pointer', async () => {
    write('.deerdawn-context.md', 'stale');
    await syncProjectFiles(client(), repo);
    expect(read('.deerdawn-context.md')).toContain('Project: Atlas');
    expect(exists('CLAUDE.md')).toBe(false);
  });

  it('shared skills follow the same rule: only sinks that already exist are updated', async () => {
    write('AGENTS.md', `${OLD_SKILLS}\n\n${MINE}`);
    write('.claude/skills/deerdawn-deploy-runbook/SKILL.md', 'old skill body');
    // No .cursor/rules skill file, no copilot file, no skills block anywhere else.

    await syncProjectFiles(client([skill]), repo);

    expect(read('AGENTS.md')).toContain('Deploy runbook');
    expect(read('AGENTS.md')).not.toContain('OLD INDEX');
    expect(read('.claude/skills/deerdawn-deploy-runbook/SKILL.md')).toContain('Run make ship.');
    expect(exists('.cursor/rules/deerdawn-deploy-runbook.mdc')).toBe(false);
    expect(exists('.github/copilot-instructions.md')).toBe(false);
  });

  it('a repo with no skills sink gets none', async () => {
    write('AGENTS.md', MINE);
    await syncProjectFiles(client([skill]), repo);
    expect(exists('.claude')).toBe(false);
    expect(exists('.cursor')).toBe(false);
    expect(read('AGENTS.md')).toBe(MINE);
  });
});

describe('full setup for a chosen tool writes that tool\'s files', () => {
  it('claude_code: the context file, CLAUDE.md and the Claude skills; nothing of another tool\'s', async () => {
    await syncProjectFiles(client([skill]), repo, undefined, { tools: ['claude_code'] });

    expect(read('.deerdawn-context.md')).toContain('Project: Atlas');
    expect(read('CLAUDE.md')).toContain('@.deerdawn-context.md');
    expect(read('.claude/skills/deerdawn-deploy-runbook/SKILL.md')).toContain('Run make ship.');
    expect(exists('AGENTS.md')).toBe(false);
    expect(exists('.cursorrules')).toBe(false);
    expect(exists('.cursor')).toBe(false);
  });

  it('codex: AGENTS.md with the block and the skills index', async () => {
    await syncProjectFiles(client([skill]), repo, undefined, { tools: ['codex'] });

    expect(read('AGENTS.md')).toContain(START);
    expect(read('AGENTS.md')).toContain('Deploy runbook');
    expect(exists('CLAUDE.md')).toBe(false);
    expect(exists('.claude')).toBe(false);
  });

  it('cursor: .cursorrules and the Cursor skill rules', async () => {
    await syncProjectFiles(client([skill]), repo, undefined, { tools: ['cursor'] });

    expect(read('.cursorrules')).toContain(START);
    expect(read('.cursor/rules/deerdawn-deploy-runbook.mdc')).toContain('Run make ship.');
    expect(exists('AGENTS.md')).toBe(false);
  });
});
