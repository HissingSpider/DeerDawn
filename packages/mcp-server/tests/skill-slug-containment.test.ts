/**
 * A skill slug is server-supplied, and it becomes a directory name, a file name
 * and the argument to a recursive delete. It reached all three unvalidated.
 *
 * HOME is a temp dir set before project-sync loads: the sync manifest lives under
 * ~/.deerdawn and its path is resolved at import.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('skill slugs never name a path outside the skills directory', () => {
  const ENV_KEYS = ['HOME', 'USERPROFILE'] as const;
  const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let tmp: string;
  let home: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-slug-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'work', 'repo');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const skill = (slug: string) => ({ skill_id: `id-${slug.length}`, slug, name: `Skill ${slug}`, description: 'd', visibility: 'shared', enabled: true });

  function client(slugs: string[], matched = true) {
    return {
      getActiveContextByCwd: vi.fn().mockResolvedValue(matched
        ? { brief: 'Project: Atlas', project_name: 'Atlas', project_id: 'proj-1', match_kind: 'path', last_updated: null, context: { tech_stack: [] } }
        : { brief: 'Project: Other', project_name: 'Other', project_id: 'proj-2', match_kind: 'recency_fallback', last_updated: null }),
      listSkills: vi.fn().mockResolvedValue(slugs.map(skill)),
      getSkill: vi.fn(async (slug: string) => ({ ...skill(slug), markdown_content: `# ${slug}\n\nbody` })),
      patchProjectContext: vi.fn().mockResolvedValue(undefined),
      upsertWorkspaceEntities: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  /** Every file under `dir`, relative, so "nothing else was created" is checkable. */
  function tree(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full); else out.push(path.relative(dir, full));
      }
    };
    walk(dir);
    return out.sort();
  }

  it('a traversal slug writes nothing, anywhere — and a good skill beside it still syncs', async () => {
    const { syncProjectFiles } = await import('../src/project-sync.js');
    await syncProjectFiles(client(['x/../../../../../escaped', '../up', 'deploy-runbook', 'UPPER', 'has space', '.hidden', '']), repo, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });

    expect(fs.existsSync(path.join(repo, '.claude', 'skills', 'deerdawn-deploy-runbook', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.cursor', 'rules', 'deerdawn-deploy-runbook.mdc'))).toBe(true);

    expect(fs.readdirSync(path.join(repo, '.claude', 'skills'))).toEqual(['deerdawn-deploy-runbook']);
    expect(fs.readdirSync(path.join(repo, '.cursor', 'rules'))).toEqual(['deerdawn-deploy-runbook.mdc']);
    // Nothing appeared beside or above the repo.
    expect(fs.readdirSync(path.join(tmp, 'work'))).toEqual(['repo']);
    expect(fs.readdirSync(tmp).sort()).toEqual(['home', 'work']);
    expect(tree(repo).some((f) => f.includes('escaped'))).toBe(false);
    // ...and the unsafe ones are not advertised in the AGENTS.md index either.
    const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('deploy-runbook');
    expect(agents).not.toContain('escaped');
  });

  it('the body of an unsafe skill is never even fetched', async () => {
    const c = client(['x/../../evil', 'fine']);
    const { syncProjectFiles } = await import('../src/project-sync.js');
    await syncProjectFiles(c, repo, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });
    expect(c.getSkill.mock.calls.map((call: any[]) => call[0])).toEqual(['fine']);
  });

  it('accepts the slugs the API really produces, including a long one', async () => {
    const long = 'a'.repeat(100);
    const { syncProjectFiles, isSafeSkillSlug } = await import('../src/project-sync.js');
    await syncProjectFiles(client(['a', '7zip-notes', 'release-checklist-v2', long]), repo, undefined, { tools: ['claude_code', 'codex', 'cursor', 'copilot'] });
    expect(fs.readdirSync(path.join(repo, '.claude', 'skills')).sort()).toEqual(
      ['deerdawn-7zip-notes', 'deerdawn-a', `deerdawn-${long}`, 'deerdawn-release-checklist-v2'].sort(),
    );
    expect(isSafeSkillSlug('a'.repeat(129))).toBe(false);
    expect(isSafeSkillSlug('-leading-dash')).toBe(false);
    expect(isSafeSkillSlug('under_score')).toBe(false);
  });

  describe('cleanup (the recursive delete)', () => {
    function seedManifest(skills: Record<string, string>) {
      fs.mkdirSync(path.join(home, '.deerdawn'), { recursive: true });
      fs.writeFileSync(path.join(home, '.deerdawn', 'synced-paths.json'), JSON.stringify({
        paths: { [repo]: { project_id: 'proj-1', written_at: new Date().toISOString(), skills } },
      }));
    }

    it('control: a recorded skill IS removed when the directory stops matching', async () => {
      const dir = path.join(repo, '.claude', 'skills', 'deerdawn-old-skill');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), 'x');
      seedManifest({ 'old-skill': 'sig' });
      const { syncProjectFiles } = await import('../src/project-sync.js');
      await syncProjectFiles(client([], false), repo);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('a traversal slug in the manifest does not aim rmSync outside the skills directory', async () => {
      const victimOutside = path.join(tmp, 'work', 'victim');
      const victimInRepo = path.join(repo, 'src');
      for (const d of [victimOutside, victimInRepo]) {
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'keep.txt'), 'keep');
      }
      seedManifest({
        'x/../../../../victim': 'sig',  // <repo>/../victim
        'x/../../../src': 'sig',        // <repo>/src
      });
      const { syncProjectFiles } = await import('../src/project-sync.js');
      await syncProjectFiles(client([], false), repo);
      expect(fs.readFileSync(path.join(victimOutside, 'keep.txt'), 'utf8')).toBe('keep');
      expect(fs.readFileSync(path.join(victimInRepo, 'keep.txt'), 'utf8')).toBe('keep');
    });

    it('a well-formed slug is not deleted THROUGH a symlinked skills directory', async () => {
      const elsewhere = path.join(tmp, 'work', 'elsewhere');
      fs.mkdirSync(path.join(elsewhere, 'deerdawn-legit'), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'deerdawn-legit', 'keep.txt'), 'keep');
      fs.mkdirSync(path.join(repo, '.claude'));
      fs.symlinkSync(elsewhere, path.join(repo, '.claude', 'skills'), 'dir');
      seedManifest({ legit: 'sig' });
      const { syncProjectFiles } = await import('../src/project-sync.js');
      await syncProjectFiles(client([], false), repo);
      expect(fs.readFileSync(path.join(elsewhere, 'deerdawn-legit', 'keep.txt'), 'utf8')).toBe('keep');
    });
  });
});
