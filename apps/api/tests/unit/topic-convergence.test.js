/**
 * Cross-platform topic convergence (P3 of universal life-context).
 *
 * The whole promise: discuss "Mount Shasta climb" on ChatGPT, continue on Claude
 * with full context — NOT a duplicate topic per platform. A web session has no cwd
 * and a per-URL session id, so without help the same subject on two platforms never
 * crosses the match threshold and spawns a second project. scoreProjectMatch now
 * anchors topics on their NAME appearing in the conversation. This asserts a fresh
 * cross-platform session matches the existing topic via the heuristic path (no LLM
 * call), and that an unrelated topic does NOT match. axios + store are stubbed.
 *
 * Run: node tests/unit/topic-convergence.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const originalLoad = Module._load;
let axiosStub = null;
Module._load = function (request) {
  if (request === 'axios' && axiosStub) return axiosStub;
  return originalLoad.apply(this, arguments);
};
function freshService() {
  Object.keys(require.cache).forEach((k) => { if (k.includes('extractionService')) delete require.cache[k]; });
  return require('../../src/services/extractionService');
}
function freshStore() {
  Object.keys(require.cache).forEach((k) => { if (k.includes('contextSyncStore')) delete require.cache[k]; });
  return require('../../src/store/contextSyncStore');
}

const topic = (project_id, project_name) => ({
  project_id,
  project_name,
  aliases: [],
  linked_paths: [],          // a life topic has no filesystem anchor
  linked_conversations: [],  // and (on a new platform) no prior chat URL
  context: {
    project_name,
    category: 'topic',
    description: '',
    goals: [],
    current_status: '',
    recent_decisions: [],
    recurring_context: [],
    tech_stack: [],
    file_structure_summary: [],
    current_task: '',
    open_questions: [],
    last_updated: '2026-06-01T00:00:00.000Z',
    source_summary: 'created by tests',
  },
});

const shastaInput = {
  org_id: 'org-system',
  session_id: 'web-/c/brand-new-on-chatgpt',
  tool: 'chatgpt_web',
  session_context: { host: 'chatgpt.com', conversation_ref: 'https://chatgpt.com/c/brand-new', surface_type: 'browser' },
  chunks: [
    { role: 'user', text: 'Picking back up on my Mount Shasta climb — still deciding on the Avalanche Gulch route and what gear to pack.' },
    { role: 'assistant', text: 'For Shasta via Avalanche Gulch you\'ll want crampons and an ice axe.' },
  ],
};

/**
 * "…without an LLM call" was the wrong half of this test.
 *
 * Convergence is its subject: the Shasta conversation must land on the EXISTING
 * Shasta topic rather than spawn a second one per platform, and that is decided
 * entirely by the name anchor in scoreProjectMatch, with no model involved.
 * Those assertions are the point and are unchanged.
 *
 * `callCount === 0` was never part of that. It asserted that extraction is
 * SKIPPED once routing is settled — the same premise the extraction.service
 * suite carried — which means the chunk that just converged ("still deciding on
 * the Avalanche Gulch route and what gear to pack") is stored nowhere. A topic
 * that converges correctly and then records nothing is a duplicate-free empty
 * project.
 *
 * So both halves are pinned now: the heuristic resolves the routing by itself,
 * and the model is then asked what to store.
 */
test('a fresh cross-platform session converges on the existing topic, and still extracts', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let callCount = 0;
  axiosStub = { post: async () => { callCount += 1; return { data: { choices: [{ message: { content: '{}' } }] } }; } };

  const store = freshStore();
  store.getSession = async () => null; // brand-new session on a different platform
  store.listProjects = async () => ([
    topic('topic-shasta', 'Mount Shasta climb'),
    topic('topic-kitchen', 'Kitchen renovation'),
  ]);

  try {
    const { runExtraction } = freshService();
    const result = await runExtraction({ org_id: 'org-system' }, shastaInput);
    assert.equal(result.match_decision, 'matched_existing', 'converges onto the existing topic');
    assert.equal(result.project_candidate?.project_id, 'topic-shasta', 'the SAME Shasta topic, not a new one');
    assert.equal(result.should_create_project, false, 'no duplicate topic created');
    assert.equal(
      callCount,
      1,
      'the name anchor settles WHERE this belongs with no model call, but WHAT to store is a second question and the model still has to be asked it'
    );
  } finally {
    store.getSession = undefined;
    store.listProjects = undefined;
  }
});

test('an unrelated topic is not matched by the name anchor', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = { post: async () => ({ data: { choices: [{ message: { content: '{}' } }] } }) };

  const store = freshStore();
  store.getSession = async () => null;
  store.listProjects = async () => ([topic('topic-kitchen', 'Kitchen renovation')]);

  try {
    const { runExtraction } = freshService();
    const result = await runExtraction({ org_id: 'org-system' }, shastaInput);
    // The Shasta conversation must NOT be force-matched onto the kitchen topic.
    assert.notEqual(result.project_candidate?.project_id, 'topic-kitchen', 'no false convergence across distinct topics');
  } finally {
    store.getSession = undefined;
    store.listProjects = undefined;
  }
});

test('a single-/common-word topic name does not hijack an unrelated conversation', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let callCount = 0;
  axiosStub = { post: async () => { callCount += 1; return { data: { choices: [{ message: { content: '{}' } }] } }; } };

  const store = freshStore();
  store.getSession = async () => null;
  store.listProjects = async () => ([topic('topic-vacation', 'Vacation')]);

  const codingChat = {
    org_id: 'org-system',
    session_id: 'web-/c/some-coding-chat',
    tool: 'chatgpt_web',
    session_context: { host: 'chatgpt.com', conversation_ref: 'https://chatgpt.com/c/x', surface_type: 'browser' },
    chunks: [
      { role: 'user', text: 'Refactoring the auth module before I go on vacation next week — should I extract the token logic?' },
      { role: 'assistant', text: 'Yes, extract the token refresh into its own function.' },
    ],
  };
  try {
    const { runExtraction } = freshService();
    const result = await runExtraction({ org_id: 'org-system' }, codingChat);
    // The lone word "vacation" must NOT force this coding chat onto the Vacation topic.
    assert.notEqual(result.project_candidate?.project_id, 'topic-vacation', 'single common-word name does not over-match');
  } finally {
    store.getSession = undefined;
    store.listProjects = undefined;
  }
});

test.after(() => { Module._load = originalLoad; axiosStub = null; });
