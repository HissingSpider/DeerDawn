'use strict';

// Calls to an OpenAI-compatible /chat/completions endpoint, tolerant of the
// ways non-OpenAI servers differ: some reject `response_format`, and local
// models often wrap their JSON in a ```json fence, a <think> block or a line
// of prose. The endpoint, key and model come from config/llm.js only.
//
// The HTTP client is passed in (`http`, an axios-compatible `post`) rather
// than required here, so each caller keeps the axios it already loads and the
// existing tests that stub axios per caller keep working unchanged.

const { getLlmConfig, authHeaders, resolveTimeout } = require('../config/llm');

function errorText(err) {
  const data = err?.response?.data;
  let body = '';
  if (typeof data === 'string') body = data;
  else if (data) {
    try { body = JSON.stringify(data); } catch (_) { body = ''; }
  }
  return `${body} ${err?.message || ''}`;
}

// A 400 that names the structured-output parameter: the server does not
// support it (LM Studio wants json_schema, some vLLM builds reject it outright).
function isResponseFormatRejection(err) {
  return err?.response?.status === 400
    && /response_format|json_object|json_schema/i.test(errorText(err));
}

/**
 * POST a chat completion and return the first choice's content (or undefined).
 *
 * `body` is sent as given, with `model` filled from config when absent. If it
 * carries `response_format` and the server answers 400 about it, the request
 * is retried once without it; the JSON-only instruction in the prompt and
 * parseJsonLoose carry the rest.
 */
async function chatCompletion(http, body, { timeoutMs, config = getLlmConfig() } = {}) {
  const requestBody = body.model ? body : { model: config.model, ...body };
  const options = {
    headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
    timeout: timeoutMs,
  };
  let response;
  try {
    response = await http.post(config.chatUrl, requestBody, options);
  } catch (err) {
    if (!requestBody.response_format || !isResponseFormatRejection(err)) throw err;
    console.warn('[LLM] Server rejected response_format; retrying once without it');
    const { response_format: _dropped, ...withoutFormat } = requestBody;
    response = await http.post(config.chatUrl, withoutFormat, options);
  }
  return response?.data?.choices?.[0]?.message?.content;
}

/**
 * Parse a model's JSON answer, tolerating what local models put around it:
 * a <think>…</think> reasoning block, a ```json fence, or prose before/after
 * the object. Throws (a SyntaxError) when no JSON object can be recovered, so
 * callers keep their existing "unparseable answer" path.
 */
function parseJsonLoose(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  try {
    return JSON.parse(text);
  } catch (firstErr) {
    const fenced = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()); } catch (_) { /* fall through */ }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw firstErr;
  }
}

module.exports = {
  chatCompletion,
  parseJsonLoose,
  isResponseFormatRejection,
  resolveTimeout,
};
