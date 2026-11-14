/**
 * Pluggable OpenAI-compatible LLM endpoint (config/llm.js + services/llmClient.js).
 *
 * Pins: the env contract (LLM_API_URL / LLM_API_KEY / LLM_MODEL /
 * LLM_EMBEDDING_MODEL / LLM_TIMEOUT_MS), the OPENAI_API_KEY fallback that keeps
 * existing deployments byte-for-byte unchanged, no Authorization header for a
 * keyless local server, the one-shot retry without response_format, and JSON
 * parsing that survives fences and prose. axios is stubbed the way
 * extraction.service.test.js stubs it, so nothing touches the network.
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

const LLM_ENV = ['LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_EMBEDDING_MODEL', 'LLM_TIMEOUT_MS', 'OPENAI_API_KEY', 'EXTRACTION_PROVIDER'];
const savedEnv = Object.fromEntries(LLM_ENV.map((k) => [k, process.env[k]]));
function resetEnv(values = {}) {
  for (const k of LLM_ENV) delete process.env[k];
  Object.assign(process.env, values);
}

test.after(() => {
  Module._load = originalLoad;
  axiosStub = null;
  for (const k of LLM_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const { getLlmConfig, authHeaders, resolveTimeout, describeLlmConfig } = require('../../src/config/llm');
const { chatCompletion, parseJsonLoose } = require('../../src/services/llmClient');

function freshModule(fragment, relPath) {
  Object.keys(require.cache).forEach((k) => { if (k.includes(fragment)) delete require.cache[k]; });
  return require(relPath);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test('defaults: api.openai.com, gpt-4o-mini, text-embedding-3-small, not configured without a key', () => {
  const c = getLlmConfig({});
  assert.equal(c.baseUrl, 'https://api.openai.com/v1');
  assert.equal(c.chatUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.embeddingsUrl, 'https://api.openai.com/v1/embeddings');
  assert.equal(c.model, 'gpt-4o-mini');
  assert.equal(c.embeddingModel, 'text-embedding-3-small');
  assert.equal(c.embeddingDimensions, 1536);
  assert.equal(c.apiKey, '');
  assert.equal(c.timeoutMs, null);
  assert.equal(c.isDefaultUrl, true);
  assert.equal(c.configured, false);
  assert.equal(c.embeddingsEnabled, false);
  assert.match(describeLlmConfig(c, {}), /extraction is disabled/);
});

test('OPENAI_API_KEY alone resolves exactly the pre-config endpoint and header', () => {
  const c = getLlmConfig({ OPENAI_API_KEY: 'sk-legacy' });
  assert.equal(c.apiKey, 'sk-legacy');
  assert.equal(c.chatUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.configured, true);
  assert.equal(c.embeddingsEnabled, true);
  assert.deepEqual(authHeaders(c), { Authorization: 'Bearer sk-legacy' });
});

test('LLM_API_KEY wins over OPENAI_API_KEY; an empty LLM_API_KEY falls back to it', () => {
  assert.equal(getLlmConfig({ LLM_API_KEY: 'k-new', OPENAI_API_KEY: 'sk-old' }).apiKey, 'k-new');
  assert.equal(getLlmConfig({ LLM_API_KEY: '', OPENAI_API_KEY: 'sk-old' }).apiKey, 'sk-old');
  assert.equal(getLlmConfig({ LLM_API_KEY: '   ', OPENAI_API_KEY: 'sk-old' }).apiKey, 'sk-old');
});

test('custom URL with no key: configured, no Authorization header, embeddings off unless a model is named', () => {
  const c = getLlmConfig({ LLM_API_URL: 'http://host.docker.internal:11434/v1/', LLM_MODEL: 'llama3.1' });
  assert.equal(c.baseUrl, 'http://host.docker.internal:11434/v1', 'trailing slash trimmed');
  assert.equal(c.chatUrl, 'http://host.docker.internal:11434/v1/chat/completions');
  assert.equal(c.model, 'llama3.1');
  assert.equal(c.isDefaultUrl, false);
  assert.equal(c.configured, true);
  assert.deepEqual(authHeaders(c), {});
  assert.equal(c.embeddingsEnabled, false);
  assert.match(describeLlmConfig(c, {}), /host\.docker\.internal:11434 model=llama3\.1 auth=none embeddings=hash-floor/);

  const withEmb = getLlmConfig({ LLM_API_URL: 'http://localhost:11434/v1', LLM_EMBEDDING_MODEL: 'nomic-embed-text' });
  assert.equal(withEmb.embeddingsEnabled, true);
  assert.equal(withEmb.embeddingModel, 'nomic-embed-text');
  assert.equal(withEmb.embeddingDimensions, 768);
});

test('LLM_TIMEOUT_MS overrides a call site default; junk is ignored', () => {
  assert.equal(resolveTimeout(getLlmConfig({ LLM_TIMEOUT_MS: '120000' }), 15000), 120000);
  assert.equal(resolveTimeout(getLlmConfig({ LLM_TIMEOUT_MS: 'soon' }), 15000), 15000);
  assert.equal(resolveTimeout(getLlmConfig({ LLM_TIMEOUT_MS: '0' }), 15000), 15000);
  assert.equal(resolveTimeout(getLlmConfig({}), 12000), 12000);
});

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

test('parseJsonLoose: plain, fenced, prose-wrapped and <think>-prefixed answers', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Sure! Here is the JSON:\n{"a":{"b":[1,2]}}\nLet me know.'), { a: { b: [1, 2] } });
  assert.deepEqual(parseJsonLoose('<think>the user wants {x}</think>\n{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonLoose('not json at all'), SyntaxError);
  assert.throws(() => parseJsonLoose(''), SyntaxError);
});

// ---------------------------------------------------------------------------
// chatCompletion: the response_format retry
// ---------------------------------------------------------------------------

function rejection(status, data) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data };
  return err;
}

test('chatCompletion retries once without response_format on a 400 that names it', async () => {
  const calls = [];
  const http = {
    post: async (url, body, opts) => {
      calls.push({ url, body, opts });
      if (calls.length === 1) throw rejection(400, { error: '\'response_format.type\' must be \'json_schema\' or \'text\'' });
      return { data: { choices: [{ message: { content: '{"ok":true}' } }] } };
    },
  };
  const config = getLlmConfig({ LLM_API_URL: 'http://localhost:1234/v1', LLM_MODEL: 'qwen2.5-7b-instruct' });
  const content = await chatCompletion(http, { model: config.model, response_format: { type: 'json_object' }, messages: [] }, { config, timeoutMs: 5 });
  assert.equal(content, '{"ok":true}');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal('response_format' in calls[1].body, false);
  assert.equal(calls[1].url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(calls[1].opts.headers.Authorization, undefined);
});

test('chatCompletion does not retry other failures', async () => {
  for (const err of [rejection(400, { error: 'context length exceeded' }), rejection(500, 'response_format boom'), new Error('ECONNREFUSED')]) {
    let n = 0;
    const http = { post: async () => { n += 1; throw err; } };
    await assert.rejects(chatCompletion(http, { response_format: { type: 'json_object' }, messages: [] }, { config: getLlmConfig({ OPENAI_API_KEY: 'k' }) }));
    assert.equal(n, 1);
  }
});

// ---------------------------------------------------------------------------
// Through the extraction service
// ---------------------------------------------------------------------------

const VALID = {
  match_decision: 'matched_existing',
  confidence: 0.9,
  delta: { current_task: 'write unit tests' },
  should_create_project: false,
  needs_user_confirmation: false,
  no_material_change: false,
};

function makeInput() {
  return {
    project_id: 'proj-llm-1',
    tool: 'claude_web',
    chunks: [{ role: 'user', text: 'lets write some tests for the llm endpoint' }],
    context: { project_name: 'Test Project' },
  };
}

test('extraction with only OPENAI_API_KEY sends the same URL, model, headers and body as before', async () => {
  resetEnv({ OPENAI_API_KEY: 'sk-test' });
  const calls = [];
  axiosStub = { post: async (url, body, opts) => { calls.push({ url, body, opts }); return { data: { choices: [{ message: { content: JSON.stringify(VALID) } }] } }; } };
  const { runExtraction } = freshModule('extractionService', '../../src/services/extractionService');
  const result = await runExtraction({}, makeInput());
  assert.equal(result.match_decision, 'matched_existing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.deepEqual(Object.keys(calls[0].body), ['model', 'max_tokens', 'response_format', 'messages']);
  assert.equal(calls[0].body.model, 'gpt-4o-mini');
  assert.equal(calls[0].body.max_tokens, 640);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(calls[0].opts.headers, { Authorization: 'Bearer sk-test', 'Content-Type': 'application/json' });
  assert.equal(calls[0].opts.timeout, 15000);
});

test('extraction against a keyless local server: custom URL and model, no auth, retry, fenced JSON', async () => {
  resetEnv({ LLM_API_URL: 'http://host.docker.internal:11434/v1', LLM_MODEL: 'llama3.1', LLM_TIMEOUT_MS: '90000' });
  const calls = [];
  axiosStub = {
    post: async (url, body, opts) => {
      calls.push({ url, body, opts });
      if (body.response_format) throw rejection(400, { error: { message: 'response_format is not supported' } });
      return { data: { choices: [{ message: { content: 'Here you go:\n```json\n' + JSON.stringify(VALID) + '\n```' } }] } };
    },
  };
  const { runExtraction } = freshModule('extractionService', '../../src/services/extractionService');
  const result = await runExtraction({}, makeInput());
  assert.equal(result.match_decision, 'matched_existing');
  assert.equal(result.delta.current_task, 'write unit tests');
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url, 'http://host.docker.internal:11434/v1/chat/completions');
    assert.equal(c.body.model, 'llama3.1');
    assert.equal('Authorization' in c.opts.headers, false);
    assert.equal(c.opts.timeout, 90000);
  }
});

test('extraction with no key on the default URL degrades as before and makes no call', async () => {
  resetEnv({});
  let n = 0;
  axiosStub = { post: async () => { n += 1; return {}; } };
  const { runExtraction, runExtractionForSeed } = freshModule('extractionService', '../../src/services/extractionService');
  const result = await runExtraction({}, makeInput());
  assert.equal(result.match_decision, 'ambiguous');
  assert.equal(result.confidence, 0);
  const seed = await runExtractionForSeed({}, 'Imported', [{ role: 'user', text: 'x'.repeat(120) }]);
  assert.equal(seed.not_processed, true);
  assert.equal(n, 0);
});

test('embeddings: OPENAI_API_KEY alone keeps text-embedding-3-small at api.openai.com', async () => {
  resetEnv({ OPENAI_API_KEY: 'sk-emb' });
  const calls = [];
  axiosStub = { post: async (url, body, opts) => { calls.push({ url, body, opts }); return { data: { data: [{ embedding: [0.1, 0.2] }] } }; } };
  const emb = freshModule('contextGraphEmbeddingService', '../../src/services/contextGraphEmbeddingService');
  assert.equal(emb.MODEL, 'text-embedding-3-small');
  assert.equal(emb.DIMENSIONS, 1536);
  await emb.embedText('hello pluggable world');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/embeddings');
  assert.equal(calls[0].body.model, 'text-embedding-3-small');
  assert.deepEqual(calls[0].opts.headers, { Authorization: 'Bearer sk-emb' });
  assert.equal(calls[0].opts.timeout, 8000);
});

test('embeddings: a custom URL without LLM_EMBEDDING_MODEL stays on the hash floor', async () => {
  resetEnv({ LLM_API_URL: 'https://openrouter.ai/api/v1', LLM_API_KEY: 'or-key' });
  let n = 0;
  axiosStub = { post: async () => { n += 1; return {}; } };
  const emb = freshModule('contextGraphEmbeddingService', '../../src/services/contextGraphEmbeddingService');
  assert.equal(emb.MODEL, 'hash-embed-v2');
  const vec = await emb.embedText('hash floor please');
  assert.equal(vec.length, 256);
  assert.equal(n, 0);
});
