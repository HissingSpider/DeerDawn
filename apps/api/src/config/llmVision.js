'use strict';

// OPTIONAL IMAGE DESCRIPTION, beside config/llm.js and sharing its endpoint and
// key. Off unless LLM_VISION_MODEL is set: then ctx.llm is null and add-ons
// fall back to asking the agent (the Wardrobe review queue does exactly that).
//
//   LLM_VISION_MODEL   a vision-capable chat model on the LLM_API_URL server,
//                      e.g. gpt-4o-mini, or llava on Ollama
//
// OpenAI-compatible chat completions with an image_url part carrying a data
// URL, which OpenAI, Ollama, LM Studio, vLLM and OpenRouter all accept.

const sharp = require('sharp');
const { getLlmConfig, authHeaders, resolveTimeout } = require('./llm');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_EDGE = 1024;

function getVisionConfig(env = process.env) {
  const model = typeof env.LLM_VISION_MODEL === 'string' ? env.LLM_VISION_MODEL.trim() : '';
  if (!model) return null;
  const base = getLlmConfig(env);
  if (!base.configured) return null;
  return { ...base, visionModel: model };
}

/**
 * Describe an image. Returns the model's text.
 * @param {Buffer} buffer any image sharp can read
 * @param {string} [prompt]
 */
async function describeImage(buffer, prompt = 'Describe this image in two or three plain sentences.', { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getVisionConfig(env);
  if (!config) throw new Error('vision_not_configured');
  // Downsized JPEG: smaller request, and no metadata leaves the server.
  const jpeg = await sharp(buffer).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 }).toBuffer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(config, DEFAULT_TIMEOUT_MS));
  try {
    const res = await fetchImpl(config.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
      body: JSON.stringify({
        model: config.visionModel,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: String(prompt).slice(0, 4000) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
          ],
        }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`vision model answered ${res.status}`);
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim() : '';
  } finally {
    clearTimeout(timer);
  }
}

/** The `ctx.llm` value: an object with describeImage, or null when unconfigured. */
function visionCapability(env = process.env) {
  if (!getVisionConfig(env)) return null;
  return { describeImage: (buffer, prompt) => describeImage(buffer, prompt, { env }) };
}

module.exports = { getVisionConfig, describeImage, visionCapability };
