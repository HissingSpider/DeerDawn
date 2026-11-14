import { describe, expect, it, vi } from 'vitest';

import {
  legacyNormalizeProjectName,
  normalizeProjectName,
  projectsNamedLike,
  resolveProjectRefs,
} from '../src/project-ref.js';

/**
 * WHICH NAMES ARE THE SAME PROJECT.
 *
 * project-ref.ts rewrites a project NAME in a tool's arguments into an id, so its
 * idea of "the same name" decides where a write lands. It carried a copy of the
 * rule the server has since replaced — keep [a-z0-9], drop everything else —
 * which merged `C#`, `C++` and `C`, and reduced a name with no Latin letter
 * ("支付网关") to '', a value the resolver skips: such a project could not be
 * referred to by name at all.
 *
 * The server's implementation cannot be imported here. It is a private function
 * of apps/api's contextSyncService, a CommonJS module that needs a database to
 * load, and the branch that changes it may merge after this one. So the two are
 * pinned by CASES instead: the table below is the server's own
 * (apps/api/tests/unit/context-routing-round-e.test.js, section c) plus the
 * examples written into normalizeName's comment. A change to either rule that
 * is not made to both shows up as a row here that no longer matches.
 */

const SAME: Array<[string, string]> = [
  ['DeerDawn API', 'deerdawn-api'],
  ['DeerDawn API', 'deerdawn api'],
  ['Parser C++', 'PARSER-C++'],
  ['Parser C++', 'parser  c++'],
  ['Parser C#', 'parser c#'],
  ['Платёжный шлюз', 'платёжный  ШЛЮЗ'],
  // NFKC: a composed "ё" and a decomposed one are one letter.
  ['Платёжный шлюз', 'Плате\u0308жный шлюз'],
  // Full-width forms fold to ASCII under NFKC.
  ['ＡＰＩ Gateway', 'api gateway'],
  // Free-standing # and + are punctuation, exactly as under the old rule.
  ['Node + React', 'node react'],
  ['Issue #42 board', 'issue 42 board'],
  ['Notepad++', 'notepad++'],
];

const DIFFERENT: Array<[string, string]> = [
  ['Parser C#', 'Parser C++'],
  ['Parser C#', 'Parser C'],
  ['Parser C++', 'Parser C'],
  ['支付网关', '订单服务'],
  ['支付网关', ''],
  ['api', 'API Gateway'],
  // Combining marks are letters' vowels in Devanagari; dropping them merges words.
  ['कम', 'काम'],
];

describe('normalizeProjectName mirrors the server rule', () => {
  it.each(SAME)('%s and %s are one name', (a, b) => {
    expect(normalizeProjectName(a)).toBe(normalizeProjectName(b));
    expect(normalizeProjectName(a)).not.toBe('');
  });

  it.each(DIFFERENT)('%s and %s are different names', (a, b) => {
    expect(normalizeProjectName(a)).not.toBe(normalizeProjectName(b));
  });

  it('keeps the exact outputs the server documents', () => {
    expect(normalizeProjectName('C#')).toBe('c#');
    expect(normalizeProjectName('C++')).toBe('c++');
    expect(normalizeProjectName('C')).toBe('c');
    expect(normalizeProjectName('Node + React')).toBe('nodereact');
    expect(normalizeProjectName('Issue #42')).toBe('issue42');
    expect(normalizeProjectName('支付网关')).toBe('支付网关');
    expect(normalizeProjectName(null)).toBe('');
  });

  it('keeps the old rule available, unchanged, for the fallback tier only', () => {
    expect(legacyNormalizeProjectName('Roadmap C#')).toBe('roadmapc');
    expect(legacyNormalizeProjectName('支付网关')).toBe('');
  });
});

function fakeClient(live: any[], archived: any[] = []) {
  return {
    listContextProjects: vi.fn().mockResolvedValue({ projects: live }),
    listArchivedContextProjects: vi.fn().mockResolvedValue({ projects: archived }),
  };
}

const resolve = async (name: string, live: any[], archived: any[] = []) =>
  resolveProjectRefs({ project_id: name, summary: 'x' }, fakeClient(live, archived) as any);

describe('resolving a name to an id', () => {
  const SHARP = { project_id: 'project_sharp', project_name: 'Parser C#' };
  const PLUS = { project_id: 'project_plus', project_name: 'Parser C++' };
  const PLAIN = { project_id: 'project_plain', project_name: 'Parser C' };

  it('C#, C++ and a plain name each resolve to their own project', async () => {
    const live = [SHARP, PLUS, PLAIN];
    expect((await resolve('parser c#', live)).args.project_id).toBe('project_sharp');
    expect((await resolve('PARSER-C++', live)).args.project_id).toBe('project_plus');
    const plain = await resolve('Parser C', live);
    expect(plain.refusal, 'three projects used to share the name "parserc"').toBeUndefined();
    expect(plain.args.project_id).toBe('project_plain');
  });

  it('a name in a non-Latin script resolves', async () => {
    const live = [
      { project_id: 'project_cjk', project_name: '支付网关' },
      { project_id: 'project_cyr', project_name: 'Платёжный шлюз' },
    ];
    expect((await resolve('支付网关', live)).args.project_id).toBe('project_cjk');
    expect((await resolve('платёжный  ШЛЮЗ', live)).args.project_id).toBe('project_cyr');
    expect((await resolve('订单服务', live)).args.project_id).toBe('订单服务');
  });

  describe('the old rule, as a fallback tier', () => {
    const ROADMAP = { project_id: 'project_roadmap', project_name: 'Roadmap C#' };
    const MIXED = { project_id: 'project_mixed', project_name: 'Alpha 项目' };

    it('a reference only the old rule matched still reaches its project', async () => {
      expect((await resolve('roadmap c', [ROADMAP, MIXED])).args.project_id).toBe('project_roadmap');
      expect((await resolve('alpha', [ROADMAP, MIXED])).args.project_id).toBe('project_mixed');
    });

    it('is not consulted once a project really is called that', async () => {
      const exact = { project_id: 'project_exact', project_name: 'Roadmap C' };
      const outcome = await resolve('roadmap c', [ROADMAP, exact]);
      expect(outcome.refusal).toBeUndefined();
      expect(outcome.args.project_id).toBe('project_exact');
    });

    it('does not outvote an exact match that is archived', async () => {
      const archivedExact = { project_id: 'project_archived_exact', project_name: 'Roadmap C' };
      const outcome = await resolve('roadmap c', [ROADMAP], [archivedExact]);
      expect(outcome.args.project_id).toBe('project_archived_exact');
    });

    it('never resolves a fragment of the reference', async () => {
      // The old rule kept "gateway" and threw "支付" away.
      const outcome = await resolve('支付 Gateway', [{ project_id: 'project_gateway', project_name: 'Gateway' }]);
      expect(outcome.args.project_id).toBe('支付 Gateway');
    });

    it('two old-rule matches are ambiguous, and refused', async () => {
      const outcome = await resolve('notes c', [
        { project_id: 'project_notes_sharp', project_name: 'Notes C#' },
        { project_id: 'project_notes_plus', project_name: 'Notes C++' },
      ]);
      expect(outcome.refusal).toContain('project_notes_sharp');
      expect(outcome.refusal).toContain('project_notes_plus');
      expect(outcome.args.project_id).toBe('notes c');
    });
  });
});

describe('projectsNamedLike (would the server call this a duplicate?)', () => {
  it('uses the current rule only, names only, and sees subprojects', () => {
    const rows = [
      { project_id: 'project_a', project_name: 'Acme-Platform', subprojects: [{ project_id: 'project_sub', project_name: 'Acme  API' }] },
      { project_id: 'project_b', project_name: 'Roadmap C#', aliases: ['roadmap'] },
    ];
    expect(projectsNamedLike('acme platform', rows).map((r) => r.project_id)).toEqual(['project_a']);
    expect(projectsNamedLike('Acme API', rows).map((r) => r.project_id)).toEqual(['project_sub']);
    // Not the legacy tier: "Roadmap C" is a different project to the server.
    expect(projectsNamedLike('Roadmap C', rows)).toEqual([]);
    // Not an alias: the duplicate gate compares names.
    expect(projectsNamedLike('roadmap', rows)).toEqual([]);
    expect(projectsNamedLike('', rows)).toEqual([]);
  });
});
