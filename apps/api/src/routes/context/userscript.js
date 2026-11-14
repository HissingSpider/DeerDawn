const express = require('express');
const db = require('../../config/db');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { generateApiKey } = require('../../utils/security');

const router = express.Router();

// Marker used to detect an already-injected message (prevents double-prepending).
const CONTEXT_MARKER = '[DeerDawn context]';
// Directive preamble prepended ahead of the context brief on browser surfaces
// (claude.ai, chatgpt). Unlike a bare data tag, this instructs the model to
// treat the brief as authoritative and ground its answer in it. Keep this on a
// single line with no apostrophes/single-quotes — it is embedded inside a
// single-quoted string in the generated userscript.
const CONTEXT_PREAMBLE = `${CONTEXT_MARKER} Authoritative DeerDawn context for this user — current project, decisions, and preferences. Base your response on it and do not re-ask for details it already provides:`;

const TOOL_CONFIGS = {
  claude_web: {
    match: 'https://claude.ai/*',
    name: 'claude_web',
    findComposer: `
    function findComposer() {
      return document.querySelector('[contenteditable="true"][data-testid]')
        || document.querySelector('.ProseMirror[contenteditable="true"]')
        || document.querySelector('[contenteditable="true"]');
    }
    function isNewConversation() {
      return /\\/new$/.test(location.pathname) || /\\/chat\\/new/.test(location.pathname);
    }
    function onMessageSend(el, contextBrief) {
      const btn = document.querySelector('button[aria-label*="Send"], button[data-testid*="send"]');
      if (!btn) return;
      function handleSend() {
        const text = el.textContent.trim();
        if (text && !text.startsWith('${CONTEXT_MARKER}')) {
          const prefix = document.createTextNode('${CONTEXT_PREAMBLE} ' + contextBrief + '\\n\\n');
          el.insertBefore(prefix, el.firstChild);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        btn.removeEventListener('click', handleSend);
      }
      btn.addEventListener('click', handleSend, { once: true });
    }`,
    captureMessages: `
    function captureMessages() {
      var out = [];
      document.querySelectorAll('[data-testid="user-message"]').forEach(function(n) {
        var t = (n.innerText || '').trim();
        if (t) out.push({ role: 'user', text: t, _y: n.getBoundingClientRect().top + window.scrollY });
      });
      document.querySelectorAll('.font-claude-message, [data-testid="assistant-message"]').forEach(function(n) {
        var t = (n.innerText || '').trim();
        if (t) out.push({ role: 'assistant', text: t, _y: n.getBoundingClientRect().top + window.scrollY });
      });
      return out.sort(function(a, b) { return a._y - b._y; }).map(function(m) { return { role: m.role, text: m.text }; });
    }`,
  },
  chatgpt_web: {
    match: 'https://chatgpt.com/*',
    name: 'chatgpt_web',
    findComposer: `
    function findComposer() {
      return document.querySelector('textarea#prompt-textarea')
        || document.querySelector('div[contenteditable="true"]');
    }
    function isNewConversation() {
      return location.pathname === '/' || /\\/new$/.test(location.pathname);
    }
    function onMessageSend(el, contextBrief) {
      const form = el.closest('form');
      if (!form) return;
      function handleSubmit() {
        const text = el.value || el.textContent || '';
        if (text.trim() && !text.startsWith('${CONTEXT_MARKER}')) {
          if (el.tagName === 'TEXTAREA') {
            const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeInput.call(el, '${CONTEXT_PREAMBLE} ' + contextBrief + '\\n\\n' + text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            el.textContent = '${CONTEXT_PREAMBLE} ' + contextBrief + '\\n\\n' + text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
        form.removeEventListener('submit', handleSubmit);
      }
      form.addEventListener('submit', handleSubmit, { once: true });
    }`,
    captureMessages: `
    function captureMessages() {
      var out = [];
      document.querySelectorAll('[data-message-author-role]').forEach(function(n) {
        var role = n.getAttribute('data-message-author-role');
        var t = (n.innerText || '').trim();
        if ((role === 'user' || role === 'assistant') && t) out.push({ role: role, text: t });
      });
      return out;
    }`,
  },
  gemini: {
    match: 'https://gemini.google.com/*',
    name: 'gemini',
    findComposer: `
    function findComposer() {
      return document.querySelector('rich-textarea .ql-editor[contenteditable="true"]')
        || document.querySelector('div[contenteditable="true"][role="textbox"]')
        || document.querySelector('textarea');
    }
    function isNewConversation() {
      return location.pathname === '/app' || /\\/app\\/?$/.test(location.pathname);
    }
    function onMessageSend(el, contextBrief) {
      var btn = document.querySelector('button[aria-label*="Send"], button[mattooltip*="Send"]');
      function inject() {
        var text = (el.innerText || el.value || '').trim();
        if (text && text.indexOf('${CONTEXT_MARKER}') === -1) {
          if (el.tagName === 'TEXTAREA') {
            el.value = '${CONTEXT_PREAMBLE} ' + contextBrief + '\\n\\n' + el.value;
          } else {
            var prefix = document.createTextNode('${CONTEXT_PREAMBLE} ' + contextBrief + '\\n\\n');
            el.insertBefore(prefix, el.firstChild);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (btn) btn.addEventListener('click', inject, { once: true });
    }`,
    captureMessages: `
    function captureMessages() {
      var out = [];
      document.querySelectorAll('user-query, .query-text').forEach(function(n) {
        var t = (n.innerText || '').trim();
        if (t) out.push({ role: 'user', text: t, _y: n.getBoundingClientRect().top + window.scrollY });
      });
      document.querySelectorAll('model-response, .model-response-text, message-content').forEach(function(n) {
        var t = (n.innerText || '').trim();
        if (t) out.push({ role: 'assistant', text: t, _y: n.getBoundingClientRect().top + window.scrollY });
      });
      return out.sort(function(a, b) { return a._y - b._y; }).map(function(m) { return { role: m.role, text: m.text }; });
    }`,
  },
  perplexity: {
    match: 'https://www.perplexity.ai/*',
    name: 'perplexity',
    findComposer: `
    function findComposer() {
      return document.querySelector('textarea[placeholder]')
        || document.querySelector('textarea')
        || document.querySelector('div[contenteditable="true"]');
    }
    function isNewConversation() {
      return location.pathname === '/' || /\\/search\\/new/.test(location.pathname);
    }
    function onMessageSend(el, contextBrief) {
      var form = el.closest('form');
      function inject() {
        var text = (el.value || el.innerText || '').trim();
        if (text && text.indexOf('${CONTEXT_MARKER}') === -1) {
          if (el.tagName === 'TEXTAREA') {
            var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(el, '${CONTEXT_PREAMBLE} ' + contextBrief + '\\n\\n' + el.value);
          } else {
            el.textContent = '${CONTEXT_PREAMBLE} ' + contextBrief + '\\n\\n' + el.textContent;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (form) form.addEventListener('submit', inject, { once: true });
    }`,
    captureMessages: `
    function captureMessages() {
      var out = [];
      document.querySelectorAll('[class*="query"]').forEach(function(n) {
        var t = (n.innerText || '').trim();
        if (t && t.length < 2000) out.push({ role: 'user', text: t, _y: n.getBoundingClientRect().top + window.scrollY });
      });
      document.querySelectorAll('.prose, [class*="answer"]').forEach(function(n) {
        var t = (n.innerText || '').trim();
        if (t) out.push({ role: 'assistant', text: t, _y: n.getBoundingClientRect().top + window.scrollY });
      });
      return out.sort(function(a, b) { return a._y - b._y; }).map(function(m) { return { role: m.role, text: m.text }; });
    }`,
  },
};

async function createUserscriptApiKey(actor) {
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${crypto.randomUUID()}`;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, `Userscript - ${new Date().toISOString().slice(0, 10)}`, actor.id, actor.org_id, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    actor.org_id
  );

  return key;
}

router.use(requireAuth, requireRole(['admin', 'operator']));

router.get('/', async (req, res) => {
  const tool = typeof req.query.tool === 'string' ? req.query.tool : 'claude_web';
  const cfg = TOOL_CONFIGS[tool] || TOOL_CONFIGS.claude_web;

  if (!req.actor?.id || !req.actor?.org_id) {
    return res.status(403).send('// Missing organization context');
  }

  const apiBase = req.get('host')?.includes('localhost')
    ? 'http://localhost:8080'
    // Self-hosted: its own public URL, else the host that served this script.
    : (require('../../config/selfHosted').isSelfHosted()
      ? (require('../../config/selfHosted').apiBaseUrl() || `${req.protocol}://${req.get('host')}`)
      : 'https://api.deerdawn.com');

  try {
    const key = await createUserscriptApiKey(req.actor);
    const script = `// ==UserScript==
// @name         DeerDawn Context Sync (${cfg.name})
// @namespace    https://deerdawn.com
// @version      1.2
// @description  Two-way DeerDawn sync: injects your context into new conversations and captures what you build back into your shared memory
// @author       DeerDawn
// @match        ${cfg.match}
// @grant        GM_xmlhttpRequest
// @connect      ${req.get('host') || 'api.deerdawn.com'}
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const API_KEY = '${key}';
  const API_BASE = '${apiBase}';
  const TOOL = '${cfg.name}';
  const INJECTED_FLAG = 'data-dd-injected';

  ${cfg.findComposer}
  ${cfg.captureMessages}

  let contextBrief = null;
  let lastPathname = location.pathname;
  let activeTopic = null;
  let topicCandidates = [];
  let ddLastRebindPath = null;

  function ddTz() { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  function ddSessionId() { return 'web-' + location.pathname; }

  // ── Bidirectional capture ──────────────────────────────────────────────────
  // Web tools no longer just consume the shared brain — they write back to it.
  // After each turn settles, the latest user+assistant exchange is POSTed to the
  // same extraction pipeline Claude Code/Codex use, so memory accrues from every
  // platform. Debounced so we only capture once the assistant finishes streaming.
  const captured = {};
  let captureTimer = null;
  function scheduleCapture() {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(doCapture, 2500);
  }
  function doCapture() {
    let msgs;
    try { msgs = captureMessages(); } catch (e) { return; }
    if (!msgs || msgs.length < 2) return;
    let ai = -1;
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'assistant') { ai = i; break; } }
    if (ai < 1) return;
    let ui = -1;
    for (let i = ai - 1; i >= 0; i--) { if (msgs[i].role === 'user') { ui = i; break; } }
    if (ui < 0) return;
    let userText = msgs[ui].text || '';
    // Strip our own injected context preamble so we never re-ingest the brief.
    if (userText.indexOf('${CONTEXT_MARKER}') !== -1) {
      const parts = userText.split('\\n\\n');
      userText = parts.length > 1 ? parts.slice(1).join('\\n\\n').trim() : '';
    }
    const aiText = msgs[ai].text || '';
    if (aiText.length < 40) return; // skip trivial replies
    const dedupKey = userText.slice(0, 80) + '|' + aiText.slice(0, 160);
    if (captured[dedupKey]) return;
    captured[dedupKey] = 1;
    const chunks = [];
    if (userText) chunks.push({ role: 'user', text: userText.slice(0, 8000) });
    chunks.push({ role: 'assistant', text: aiText.slice(0, 8000) });
    GM_xmlhttpRequest({
      method: 'POST',
      url: API_BASE + '/api/v1/context/extraction',
      headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
      data: JSON.stringify({
        tool: TOOL,
        session_id: 'web-' + location.pathname,
        session_context: { host: location.hostname, conversation_ref: location.href, surface_type: 'browser', tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
        chunks: chunks
      }),
      onload: function() {}, onerror: function() {}
    });
  }

  function fetchContext() {
    // Prefer the session-bound TOPIC brief (carries the current time + any
    // conversation-triggered enrichments); fall back to the multi-project map
    // only when this chat isn't bound to a topic yet.
    GM_xmlhttpRequest({
      method: 'GET',
      url: API_BASE + '/api/v1/context/session/topic?session_id=' + encodeURIComponent(ddSessionId()) + '&tool=' + TOOL + '&tz=' + encodeURIComponent(ddTz()),
      headers: { 'X-Api-Key': API_KEY },
      onload: function(resp) {
        try {
          const data = JSON.parse(resp.responseText);
          activeTopic = data.active_topic || null;
          topicCandidates = data.candidates || [];
          renderChip();
          // Chat platforms rewrite the URL (/new -> /c/<id>) after the first
          // message, which changes ddSessionId() and orphans a just-confirmed
          // binding. If this session is unbound but we remembered a topic for this
          // tab, re-bind it once so the user's choice survives the rewrite.
          if (!activeTopic) {
            var remembered = ddStoredTopic();
            if (remembered && remembered.project_id && ddLastRebindPath !== location.pathname) {
              ddLastRebindPath = location.pathname;
              bindTopic({ project_id: remembered.project_id });
              return;
            }
          }
          if (data.brief) { contextBrief = data.brief; return; }
        } catch(e) {}
        fetchMap();
      },
      onerror: function() { fetchMap(); }
    });
  }

  function ddStoredTopic() {
    try { return JSON.parse(sessionStorage.getItem('dd_active_topic') || 'null'); } catch(e) { return null; }
  }

  function fetchMap() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: API_BASE + '/api/v1/context/map?tool=' + TOOL + '&tz=' + encodeURIComponent(ddTz()),
      headers: { 'X-Api-Key': API_KEY },
      onload: function(resp) {
        try { contextBrief = JSON.parse(resp.responseText).map || null; } catch(e) {}
        renderChip();
      }
    });
  }

  // ── Topic confirm chip ──────────────────────────────────────────────────────
  // A small in-page control showing which topic this chat is syncing to, so the
  // same subject discussed on different platforms converges on ONE topic instead
  // of silently duplicating. The user can confirm, switch, or start a new topic.
  function renderChip() {
    let chip = document.getElementById('dd-topic-chip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'dd-topic-chip';
      chip.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;font:12px/1.4 system-ui,-apple-system,sans-serif;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,0.14);border-radius:9999px;padding:6px 12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.45);user-select:none;';
      chip.addEventListener('click', toggleTopicMenu);
      document.body.appendChild(chip);
    }
    chip.textContent = 'Context: ' + (activeTopic ? activeTopic.project_name : 'none') + ' \\u25be';
  }

  function toggleTopicMenu() {
    const existing = document.getElementById('dd-topic-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div');
    menu.id = 'dd-topic-menu';
    menu.style.cssText = 'position:fixed;bottom:52px;right:16px;z-index:2147483647;font:12px/1.4 system-ui,-apple-system,sans-serif;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,0.14);border-radius:10px;padding:6px;min-width:210px;max-height:320px;overflow:auto;box-shadow:0 4px 16px rgba(0,0,0,0.5);';
    topicCandidates.forEach(function(c) {
      const item = document.createElement('div');
      item.textContent = c.project_name;
      item.style.cssText = 'padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      item.addEventListener('mouseenter', function(){ item.style.background = 'rgba(255,255,255,0.07)'; });
      item.addEventListener('mouseleave', function(){ item.style.background = 'transparent'; });
      item.addEventListener('click', function(){ bindTopic({ project_id: c.project_id }); });
      menu.appendChild(item);
    });
    const add = document.createElement('div');
    add.textContent = '+ New topic\\u2026';
    add.style.cssText = 'padding:6px 10px;border-radius:6px;cursor:pointer;border-top:1px solid rgba(255,255,255,0.1);margin-top:4px;color:#9be6c0;';
    add.addEventListener('click', function(){
      const name = prompt('Name this topic:');
      if (name && name.trim()) bindTopic({ new_topic_name: name.trim() });
    });
    menu.appendChild(add);
    document.body.appendChild(menu);
  }

  function bindTopic(sel) {
    const body = { session_id: ddSessionId(), tool: TOOL, conversation_ref: location.href, host: location.hostname };
    if (sel.project_id) body.project_id = sel.project_id;
    if (sel.new_topic_name) body.new_topic_name = sel.new_topic_name;
    GM_xmlhttpRequest({
      method: 'POST',
      url: API_BASE + '/api/v1/context/session/topic',
      headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
      data: JSON.stringify(body),
      onload: function(resp) {
        try {
          const bound = JSON.parse(resp.responseText);
          if (bound && bound.project_id) {
            // Remember this tab's topic so it survives the new->permalink URL rewrite.
            sessionStorage.setItem('dd_active_topic', JSON.stringify({ project_id: bound.project_id, project_name: bound.project_name }));
          }
        } catch(e) {}
        const menu = document.getElementById('dd-topic-menu'); if (menu) menu.remove();
        const flag = document.querySelector('[' + INJECTED_FLAG + ']');
        if (flag) flag.removeAttribute(INJECTED_FLAG); // allow re-injection with the new topic
        fetchContext();
      },
      onerror: function() {}
    });
  }

  function tryAttach() {
    const el = findComposer();
    if (!el || el.hasAttribute(INJECTED_FLAG)) return;
    if (!contextBrief) return;
    el.setAttribute(INJECTED_FLAG, '1');
    onMessageSend(el, contextBrief);
  }

  fetchContext();

  const navObserver = new MutationObserver(function() {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      if (isNewConversation()) {
        fetchContext();
        setTimeout(tryAttach, 800);
      }
    }
    // Any DOM activity (e.g. assistant streaming) re-arms the debounced capture.
    scheduleCapture();
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  setTimeout(function() {
    if (isNewConversation() || !location.pathname.includes('/c/')) {
      tryAttach();
    }
  }, 1200);
})();
`;

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="deerdawn-${tool}.user.js"`);
    return res.send(script);
  } catch (err) {
    console.error('[USERSCRIPT] Failed to create installer script:', err.message);
    return res.status(500).send('// Failed to generate DeerDawn userscript');
  }
});

module.exports = router;
