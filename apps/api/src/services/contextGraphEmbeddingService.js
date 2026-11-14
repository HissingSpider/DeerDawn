const crypto = require('crypto');
const axios = require('axios');
const { getLlmConfig, authHeaders, resolveTimeout } = require('../config/llm');

const HASH_DIMS = 256;

// Resolved once at load, as before: MODEL is the key stored vectors are filed
// under, so it must not change under a running process. Remote embeddings are
// on for OpenAI with a key (unchanged: text-embedding-3-small, 1536 dims) or
// for a custom LLM_API_URL whose operator named an LLM_EMBEDDING_MODEL.
const LLM_CONFIG = getLlmConfig();
const useRemote = LLM_CONFIG.embeddingsEnabled;
// hash-embed-v2: 256-dim feature-hashed (unigram + bigram) floor. The version
// bump invalidates legacy 32-dim v1 vectors so they lazily re-embed.
const MODEL = useRemote ? LLM_CONFIG.embeddingModel : (process.env.CONTEXT_GRAPH_EMBEDDING_MODEL || 'hash-embed-v2');
const DIMENSIONS = useRemote ? LLM_CONFIG.embeddingDimensions : HASH_DIMS;

// Simple LRU cache — 100 entries, keyed by text hash
const embedCache = new Map();
const CACHE_MAX = 100;

function cacheKey(text) {
  return crypto.createHash('md5').update(String(text || '')).digest('hex');
}

function cacheGet(key) {
  if (!embedCache.has(key)) return null;
  const val = embedCache.get(key);
  // refresh LRU position
  embedCache.delete(key);
  embedCache.set(key, val);
  return val;
}

function cacheSet(key, vector) {
  if (embedCache.size >= CACHE_MAX) {
    embedCache.delete(embedCache.keys().next().value);
  }
  embedCache.set(key, vector);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 256);
}

// Ultra-common tokens carry little signal — damp them so content words dominate
// (a cheap IDF floor without a corpus).
const COMMON_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is',
  'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'we', 'you',
]);

function featureWeight(feature) {
  return COMMON_TOKENS.has(feature) ? 0.3 : 1;
}

// Feature-hashing embedding: hash unigrams AND adjacent bigrams into a 256-dim
// signed vector (the "hashing trick"). Captures phrase structure and discriminates
// near-duplicates far better than the legacy 32-dim positional byte-sum.
function hashEmbed(text) {
  const vector = new Array(HASH_DIMS).fill(0);
  const tokens = tokenize(text);
  if (!tokens.length) return vector;

  const features = [];
  for (let i = 0; i < tokens.length; i += 1) {
    features.push(tokens[i]);
    if (i + 1 < tokens.length) features.push(`${tokens[i]}_${tokens[i + 1]}`);
  }

  for (const feature of features) {
    const hash = crypto.createHash('sha256').update(feature).digest();
    const index = hash.readUInt32BE(0) % HASH_DIMS;
    const sign = (hash[4] & 1) ? 1 : -1;
    vector[index] += sign * featureWeight(feature);
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vector.map((v) => Number((v / magnitude).toFixed(6)));
}

async function embedText(text) {
  const key = cacheKey(text);
  const cached = cacheGet(key);
  if (cached) return cached;

  if (!useRemote) {
    const vec = hashEmbed(text);
    cacheSet(key, vec);
    return vec;
  }

  try {
    const resp = await axios.post(
      LLM_CONFIG.embeddingsUrl,
      { model: LLM_CONFIG.embeddingModel, input: String(text || '').slice(0, 8000) },
      {
        headers: authHeaders(LLM_CONFIG),
        timeout: resolveTimeout(LLM_CONFIG, 8000),
      }
    );
    const vec = resp.data.data[0].embedding;
    cacheSet(key, vec);
    return vec;
  } catch (err) {
    console.warn('[EMBEDDING] Remote embedding failed, falling back to hash-embed:', err.message);
    const vec = hashEmbed(text);
    cacheSet(key, vec);
    return vec;
  }
}

function cosineSimilarity(a = [], b = []) {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom ? dot / denom : 0;
}

function buildNodeEmbeddingText(node) {
  return [
    node.node_type,
    node.title,
    node.summary,
    node.canonical_key,
    node.metadata?.path,
    node.metadata?.cwd,
    node.metadata?.host,
    node.metadata?.stack,
    node.project_id,
  ].filter(Boolean).join(' ');
}

function buildEvidenceEmbeddingText(evidence) {
  return [
    evidence.excerpt,
    evidence.metadata?.conversation_ref,
    evidence.metadata?.cwd,
    evidence.metadata?.host,
  ].filter(Boolean).join(' ');
}

module.exports = {
  MODEL,
  DIMENSIONS,
  embedText,
  cosineSimilarity,
  buildNodeEmbeddingText,
  buildEvidenceEmbeddingText,
  // Exported for unit testing the local embedding floor
  hashEmbed,
};
