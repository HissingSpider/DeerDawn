'use strict';

/**
 * THE BRIEF ONLY WORKED IN ASCII.
 *
 * #509 made relevance a whole-token match, which was right, and tokenised the
 * two sides differently: the candidate text was split on /[^a-z0-9]+/ while the
 * query kept whatever the person typed. So "Rechnungsprüfung" became
 * "rechnungspr" + "fung" on one side and stayed whole on the other, and a
 * Cyrillic, Greek or CJK sentence dissolved into nothing at all — every token
 * dropped, every score zero. A Russian project's own decisions could not reach
 * a brief about them, silently, while the English project next door worked.
 *
 * Both sides are tokenised the same way now: NFKC, lower case, split on
 * anything that is neither a letter nor a number. CJK has no spaces, so runs of
 * Han/Kana/Hangul also contribute character bigrams, which is what makes two
 * Japanese sentences about the same thing overlap at all.
 *
 * Stubbed store, no DB: this is about the scorer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_REDIS = 'true';

const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const embeddings = require('../../src/services/contextGraphEmbeddingService');

// One decision per language, plus a same-language decoy that shares no words, so
// "everything is included" cannot pass this.
const DECISIONS = [
  { summary: 'Решение: выставление счетов идет через очередь задач, а не через крон.', tag: /очередь задач/ },
  { summary: 'Решение: экспорт отчетов подписывается ключом организации.', tag: /экспорт отчетов/ },
  { summary: 'Entscheidung: Die Rechnungsprüfung läuft über den Prüfdienst, nicht über Cron.', tag: /Rechnungsprüfung/ },
  { summary: 'Entscheidung: Das Mandantenverzeichnis wird nächtlich neu aufgebaut.', tag: /Mandantenverzeichnis/ },
  { summary: '決定: 請求書のレンダリングはキューワーカーを通して行う。', tag: /請求書のレンダリング/ },
  { summary: '決定: 監査ログは九十日間保持する。', tag: /監査ログ/ },
  { summary: 'Decision: invoice rendering goes through the queue worker, never inline.', tag: /queue worker/ },
];

function projectFixture() {
  return {
    project_id: 'project_i18n',
    owner_key: 'org-system',
    project_name: 'Billing',
    aliases: [],
    linked_paths: [],
    linked_conversations: [],
    context: {
      project_name: 'Billing',
      current_task: '',
      current_status: '',
      recent_decisions: DECISIONS.map((entry, index) => ({
        summary: entry.summary,
        importance: 'normal',
        decided_at: `2026-08-0${index + 1}T12:00:00.000Z`,
      })),
      recurring_context: [],
      hot_paths: [],
      entrypoints: [],
      surfaces: [],
      debugging_notes: [],
      landmines: [],
      commands: [],
      open_questions: [],
      goals: [],
      tech_stack: [],
      file_structure_summary: [],
      source_summary: 'Test fixture',
      last_updated: '2026-08-07T12:00:00.000Z',
    },
    created_at: '2026-08-07T12:00:00.000Z',
    updated_at: '2026-08-07T12:00:00.000Z',
  };
}

async function withStubs(fn) {
  const project = projectFixture();
  const originals = {
    getProject: store.getProject,
    getProjectShare: store.getProjectShare,
    listProjects: store.listProjects,
    listSessions: store.listSessions,
    listGraphNodes: store.listGraphNodes,
    getGlobal: store.getGlobal,
    getGraphEmbeddings: store.getGraphEmbeddings,
    embedText: embeddings.embedText,
  };
  store.getProject = async () => project;
  store.getProjectShare = async () => ({ share: null, sections: [], members: [] });
  store.listProjects = async () => [project];
  store.listSessions = async () => [];
  store.listGraphNodes = async () => [];
  store.getGlobal = async () => null;
  store.getGraphEmbeddings = async () => [];
  embeddings.embedText = async () => new Array(256).fill(0);
  try {
    return await fn(project);
  } finally {
    Object.assign(store, {
      getProject: originals.getProject,
      getProjectShare: originals.getProjectShare,
      listProjects: originals.listProjects,
      listSessions: originals.listSessions,
      listGraphNodes: originals.listGraphNodes,
      getGlobal: originals.getGlobal,
      getGraphEmbeddings: originals.getGraphEmbeddings,
    });
    embeddings.embedText = originals.embedText;
  }
}

const brief = (task) => service.buildSubagentBrief({ org_id: 'org-system', id: 'system-key', role: 'admin' }, {
  project_id: 'project_i18n',
  task,
  max_tokens: 400,
});

// The KNOW block alone. The Objective line echoes the task verbatim, so
// matching the whole brief would pass on the question rather than the answer —
// which is exactly how this went unnoticed.
function knowBlock(text) {
  const match = String(text).match(/\nKnow:\n([\s\S]*?)(?:\n[A-Z][a-z]+ ?[a-z]*:\n|\n*$)/);
  return match ? match[1] : '';
}

const CASES = [
  {
    name: 'Russian',
    task: 'Переделать выставление счетов через очередь задач',
    wanted: /очередь задач/,
    decoy: /экспорт отчетов/,
  },
  {
    name: 'German with umlauts',
    task: 'Rechnungsprüfung über den Prüfdienst überarbeiten',
    wanted: /Rechnungsprüfung/,
    decoy: /Mandantenverzeichnis/,
  },
  {
    name: 'Japanese',
    task: '請求書のレンダリングをキューワーカーで見直す',
    wanted: /請求書のレンダリング/,
    decoy: /監査ログ/,
  },
];

for (const testCase of CASES) {
  test(`a ${testCase.name} task reaches the project's own ${testCase.name} decisions`, async () => {
    await withStubs(async () => {
      const know = knowBlock((await brief(testCase.task)).text);
      assert.match(
        know,
        testCase.wanted,
        'THE BUG: the two sides were tokenised differently, so nothing outside ASCII could match',
      );
      assert.doesNotMatch(know, testCase.decoy, 'and relevance still means relevance');
    });
  });
}

test('English relevance is unchanged', async () => {
  await withStubs(async () => {
    const know = knowBlock((await brief('Rework invoice rendering in the queue worker')).text);
    assert.match(know, /queue worker/);
    assert.doesNotMatch(know, /監査ログ/);
    assert.doesNotMatch(know, /Mandantenverzeichnis/);
  });
});
