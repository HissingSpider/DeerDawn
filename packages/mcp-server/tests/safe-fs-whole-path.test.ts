/**
 * The symlink guard looked at the last path component and nothing else.
 *
 * That stops a planted `AGENTS.md -> ~/.zshrc`. It does nothing about a planted
 * DIRECTORY: a cloned repo shipping `.claude/skills -> <somewhere else>` passes
 * the leaf check because the leaf does not exist yet, and DeerDawn's mkdir and
 * write both land on the far side of the link.
 *
 * HOME is a temp dir set before project-sync loads (it resolves its manifest
 * path at import), so nothing here touches the real home directory.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isInsideRoot, safeMkdirSync, safeWriteFileSync } from '../src/utils/safe-fs.js';

describe('whole-path symlink guard', () => {
  let tmp: string;
  let repo: string;
  let outside: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-safefs-')));
    repo = path.join(tmp, 'repo');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('isInsideRoot', () => {
    it('accepts ordinary paths, existing or not', () => {
      fs.mkdirSync(path.join(repo, 'a'));
      expect(isInsideRoot(path.join(repo, 'a', 'file.md'), repo)).toBe(true);
      expect(isInsideRoot(path.join(repo, 'not', 'yet', 'there.md'), repo)).toBe(true);
      expect(isInsideRoot(repo, repo)).toBe(true);
    });

    it('rejects a path that leaves through a symlinked PARENT', () => {
      fs.mkdirSync(path.join(repo, '.claude'));
      fs.symlinkSync(outside, path.join(repo, '.claude', 'skills'), 'dir');
      expect(isInsideRoot(path.join(repo, '.claude', 'skills', 'deerdawn-x', 'SKILL.md'), repo)).toBe(false);
    });

    it('rejects a link several components up', () => {
      fs.symlinkSync(outside, path.join(repo, '.cursor'), 'dir');
      expect(isInsideRoot(path.join(repo, '.cursor', 'rules', 'deerdawn-x.mdc'), repo)).toBe(false);
    });

    it('rejects lexical escapes and a dangling link', () => {
      expect(isInsideRoot(path.join(repo, '..', 'outside', 'x'), repo)).toBe(false);
      fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(repo, 'dangling'), 'dir');
      expect(isInsideRoot(path.join(repo, 'dangling', 'x'), repo)).toBe(false);
    });

    it('a sibling whose name merely starts with the root is outside', () => {
      fs.mkdirSync(path.join(tmp, 'repo-evil'));
      expect(isInsideRoot(path.join(tmp, 'repo-evil', 'x'), repo)).toBe(false);
    });

    it('allows a symlink that stays INSIDE the root', () => {
      fs.mkdirSync(path.join(repo, 'packages', 'shared', 'claude'), { recursive: true });
      fs.symlinkSync(path.join(repo, 'packages', 'shared', 'claude'), path.join(repo, '.claude'), 'dir');
      expect(isInsideRoot(path.join(repo, '.claude', 'skills', 'deerdawn-x', 'SKILL.md'), repo)).toBe(true);
    });

    it('is not fooled by a root that is itself reached through a link', () => {
      const alias = path.join(tmp, 'alias');
      fs.symlinkSync(repo, alias, 'dir');
      expect(isInsideRoot(path.join(alias, 'AGENTS.md'), alias)).toBe(true);
      expect(isInsideRoot(path.join(alias, 'AGENTS.md'), repo)).toBe(true);
    });
  });

  describe('safeWriteFileSync / safeMkdirSync with a root', () => {
    it('refuses the write, and the far side of the link stays untouched', () => {
      fs.symlinkSync(outside, path.join(repo, '.github'), 'dir');
      const target = path.join(repo, '.github', 'copilot-instructions.md');
      expect(safeWriteFileSync(target, 'planted', 'utf8', repo)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses the mkdir that would have run before it', () => {
      fs.mkdirSync(path.join(repo, '.claude'));
      fs.symlinkSync(outside, path.join(repo, '.claude', 'skills'), 'dir');
      expect(safeMkdirSync(path.join(repo, '.claude', 'skills', 'deerdawn-x'), repo)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('still writes normally, and still refuses a symlinked leaf', () => {
      expect(safeMkdirSync(path.join(repo, '.claude', 'skills', 'deerdawn-x'), repo)).toBe(true);
      const file = path.join(repo, '.claude', 'skills', 'deerdawn-x', 'SKILL.md');
      expect(safeWriteFileSync(file, 'ok', 'utf8', repo)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('ok');

      const victim = path.join(outside, 'victim.txt');
      fs.writeFileSync(victim, 'mine');
      fs.symlinkSync(victim, path.join(repo, 'AGENTS.md'));
      expect(safeWriteFileSync(path.join(repo, 'AGENTS.md'), 'overwritten', 'utf8', repo)).toBe(false);
      expect(fs.readFileSync(victim, 'utf8')).toBe('mine');
    });

    it('without a root it behaves exactly as before (home-directory config writes)', () => {
      fs.symlinkSync(outside, path.join(repo, 'dotfiles'), 'dir');
      expect(safeWriteFileSync(path.join(repo, 'dotfiles', 'settings.json'), '{}')).toBe(true);
      expect(fs.existsSync(path.join(outside, 'settings.json'))).toBe(true);
    });
  });

  describe('syncProjectFiles in a repo that plants a directory symlink', () => {
    const ENV_KEYS = ['HOME', 'USERPROFILE'] as const;
    const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

    beforeEach(() => {
      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      vi.resetModules();
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    });

    function clientWithOneSkill() {
      return {
        getActiveContextByCwd: vi.fn().mockResolvedValue({
          brief: 'Project: Atlas', project_name: 'Atlas', project_id: 'proj-1', match_kind: 'path',
          last_updated: '2026-06-08T00:00:00.000Z', context: { tech_stack: [] },
        }),
        listSkills: vi.fn().mockResolvedValue([{ skill_id: 's1', slug: 'deploy-runbook', name: 'Deploy runbook', description: 'How we deploy', visibility: 'shared', enabled: true }]),
        getSkill: vi.fn().mockResolvedValue({ slug: 'deploy-runbook', name: 'Deploy runbook', description: 'How we deploy', markdown_content: '# Deploy\n\nSteps.' }),
        patchProjectContext: vi.fn().mockResolvedValue(undefined),
        upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
      } as any;
    }

    it('control: skills land in the repo when nothing is planted', async () => {
      const { syncProjectFiles } = await import('../src/project-sync.js');
      await syncProjectFiles(clientWithOneSkill(), repo, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });
      expect(fs.existsSync(path.join(repo, '.claude', 'skills', 'deerdawn-deploy-runbook', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(repo, '.cursor', 'rules', 'deerdawn-deploy-runbook.mdc'))).toBe(true);
    });

    it('writes nothing outside the repo through .claude/skills, .cursor or .github', async () => {
      const ssh = path.join(outside, 'ssh');
      const cfg = path.join(outside, 'config');
      const gh = path.join(outside, 'gh');
      for (const d of [ssh, cfg, gh]) fs.mkdirSync(d);
      fs.writeFileSync(path.join(gh, 'copilot-instructions.md'), 'somebody else\'s file');
      fs.mkdirSync(path.join(repo, '.claude'));
      fs.symlinkSync(ssh, path.join(repo, '.claude', 'skills'), 'dir');
      fs.symlinkSync(cfg, path.join(repo, '.cursor'), 'dir');
      fs.symlinkSync(gh, path.join(repo, '.github'), 'dir');

      const { syncProjectFiles } = await import('../src/project-sync.js');
      await syncProjectFiles(clientWithOneSkill(), repo, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });

      expect(fs.readdirSync(ssh)).toEqual([]);
      expect(fs.readdirSync(cfg)).toEqual([]);
      expect(fs.readFileSync(path.join(gh, 'copilot-instructions.md'), 'utf8')).toBe('somebody else\'s file');
      // The rest of the sync is unaffected.
      expect(fs.existsSync(path.join(repo, '.deerdawn-context.md'))).toBe(true);
    });
  });
});
