'use strict';

// THE ONE PLACE THE LLM ENDPOINT, KEY AND MODEL COME FROM.
//
// Every call to an OpenAI-compatible API (extraction, the public repo brief,
// graph embeddings) resolves its URL, credential and model here, so a
// self-hoster can point DeerDawn at OpenAI, Ollama, LM Studio, vLLM,
// OpenRouter, Together, Groq or an Azure-compatible proxy with env alone.
//
//   LLM_API_URL          base URL, default https://api.openai.com/v1
//   LLM_API_KEY          falls back to OPENAI_API_KEY; empty = no Authorization
//   LLM_MODEL            chat model, default gpt-4o-mini
//   LLM_EMBEDDING_MODEL  embeddings model, default text-embedding-3-small
//   LLM_TIMEOUT_MS       overrides each call site's own default timeout
//
// A deployment that sets only OPENAI_API_KEY resolves to exactly what the code
// hardcoded before: the same URL, model and headers.
//
// Env is read on every call, never cached at require time: tests (and the
// extraction service's own key gate) set and clear keys after the module loads.

const DEFAULT_LLM_API_URL = 'https://api.openai.com/v1';
const DEFAULT_LLM_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

// Stored next to each vector as metadata. Retrieval filters by model name, so
// a wrong figure here never mixes vectors; it only mislabels them.
const KNOWN_EMBEDDING_DIMENSIONS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
  'bge-m3': 1024,
};

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseUrl(value) {
  const url = clean(value);
  return (url || DEFAULT_LLM_API_URL).replace(/\/+$/, '');
}

function parseTimeout(value) {
  const n = Number(clean(value));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function getLlmConfig(env = process.env) {
  const baseUrl = normalizeBaseUrl(env.LLM_API_URL);
  const isDefaultUrl = baseUrl === DEFAULT_LLM_API_URL;
  // An empty LLM_API_KEY is how compose files spell "unset", so it falls
  // through to OPENAI_API_KEY like an absent one. A local server gets neither.
  const apiKey = clean(env.LLM_API_KEY) || clean(env.OPENAI_API_KEY);
  const explicitEmbeddingModel = clean(env.LLM_EMBEDDING_MODEL);
  const embeddingModel = explicitEmbeddingModel || DEFAULT_EMBEDDING_MODEL;

  return {
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    embeddingsUrl: `${baseUrl}/embeddings`,
    apiKey,
    model: clean(env.LLM_MODEL) || DEFAULT_LLM_MODEL,
    embeddingModel,
    embeddingDimensions: KNOWN_EMBEDDING_DIMENSIONS[embeddingModel] || 1536,
    timeoutMs: parseTimeout(env.LLM_TIMEOUT_MS),
    isDefaultUrl,
    // Chat is usable when there is a key, or when the operator pointed us at
    // their own server (Ollama and friends need no key). The default OpenAI URL
    // with no key is the "no extractor configured" state the code has always
    // degraded from.
    configured: Boolean(apiKey) || !isDefaultUrl,
    // Embeddings stay on the hash floor unless they can work: OpenAI with a key
    // (as before), or an operator who named an embedding model for their own
    // server. Most chat-only endpoints (OpenRouter, Groq) serve no /embeddings,
    // and a failing call per write would only log noise and fall back anyway.
    embeddingsEnabled: isDefaultUrl ? Boolean(apiKey) : Boolean(explicitEmbeddingModel),
  };
}

// Authorization only when there is a key: a local server gets no header at all
// rather than "Bearer " with nothing after it.
function authHeaders(config) {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

function resolveTimeout(config, defaultMs) {
  return config.timeoutMs || defaultMs;
}

function describeLlmConfig(config = getLlmConfig(), env = process.env) {
  if (clean(env.EXTRACTION_PROVIDER).toLowerCase() === 'anthropic') {
    return '[BOOT] LLM: extraction uses EXTRACTION_PROVIDER=anthropic (ANTHROPIC_API_KEY); '
      + `repo briefs and embeddings use ${config.configured ? config.baseUrl : 'nothing (no LLM_API_KEY/OPENAI_API_KEY)'}.`;
  }
  if (!config.configured) {
    return '[BOOT] LLM: no LLM_API_KEY/OPENAI_API_KEY set and LLM_API_URL is the default OpenAI URL; '
      + 'extraction is disabled (sessions route but save no extracted context) and embeddings use the local hash floor.';
  }
  const host = (() => {
    try { return new URL(config.baseUrl).host; } catch (_) { return config.baseUrl; }
  })();
  return `[BOOT] LLM: ${host} model=${config.model} auth=${config.apiKey ? 'bearer' : 'none'} `
    + `embeddings=${config.embeddingsEnabled ? config.embeddingModel : 'hash-floor'}`
    + (config.timeoutMs ? ` timeout_ms=${config.timeoutMs}` : '');
}

function logLlmStatus(config = getLlmConfig()) {
  const line = describeLlmConfig(config);
  if (config.configured) console.log(line);
  else console.warn(line);
  return line;
}

module.exports = {
  DEFAULT_LLM_API_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  getLlmConfig,
  authHeaders,
  resolveTimeout,
  describeLlmConfig,
  logLlmStatus,
};
