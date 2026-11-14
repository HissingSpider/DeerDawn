const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const db = require('../../config/db');
const { requireAuth, requireAnyScope } = require('../../middleware/auth');
const contextSyncService = require('../../services/contextSyncService');
const { encryptCredential, decryptCredential } = require('../../services/contextCredentialService');
const workspace = require('../../services/workspaceService');

// ─── helpers ──────────────────────────────────────────────────────────────────

function ownerKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

router.use(requireAuth);
router.use(requireAnyScope(['context:read', 'context:write', 'context:admin']));

const requireContextWrite = requireAnyScope(['context:write', 'context:admin']);

async function buildSystemPrompt(actor) {
  try {
    const ok = ownerKey(actor);
    const projects = await contextSyncService.listProjects(actor);
    const top = (projects || []).slice(0, 3);

    let prompt = '## DeerDawn Context — authoritative, auto-updated by DeerDawn\n\n';
    prompt += 'Treat the following as the source of truth for this user across their AI tools. Ground your responses in it, keep it consistent, and do not ask for details it already provides.\n\n';

    // Global profile
    const pref = await db.query(
      'SELECT preferences FROM injection_preferences WHERE owner_key = $1', [ok], 'org-system'
    ).catch(() => null);
    const prefs = pref?.rows?.[0]?.preferences;
    if (prefs?.user_profile) {
      prompt += `### About the user\n${prefs.user_profile}\n\n`;
    }
    if (prefs?.global_stack?.length) {
      prompt += `**Tech stack:** ${prefs.global_stack.join(', ')}\n`;
    }
    if (prefs?.preferences?.length) {
      prompt += `**Preferences:** ${prefs.preferences.join(' | ')}\n\n`;
    }

    // Active projects
    if (top.length) {
      prompt += '### Active projects\n';
      for (const p of top) {
        const ctx = p.context || {};
        prompt += `**${ctx.project_name || p.project_name}**`;
        if (ctx.current_status) prompt += ` — ${ctx.current_status}`;
        if (ctx.current_task) prompt += `\nCurrent task: ${ctx.current_task}`;
        if (ctx.tech_stack?.length) prompt += `\nStack: ${ctx.tech_stack.slice(0, 5).join(', ')}`;
        prompt += '\n\n';
      }
    }

    prompt += `*Updated: ${new Date().toISOString().slice(0, 16)} UTC*`;
    return prompt;
  } catch {
    return '## DeerDawn context — authoritative\nSession memory is active. Base your responses on the saved DeerDawn context.';
  }
}

// ─── GET status ───────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const ok = ownerKey(req.actor);
    const result = await db.query(
      'SELECT provider, agent_id, agent_url, meta, updated_at FROM context_integrations WHERE owner_key = $1',
      [ok], 'org-system'
    );
    res.json({ integrations: result.rows });
  } catch (err) { next(err); }
});

// ─── Claude Managed Agent ─────────────────────────────────────────────────────

router.post('/claude-agent', requireContextWrite, async (req, res, next) => {
  try {
    const { anthropic_api_key } = req.body;
    if (!anthropic_api_key?.startsWith('sk-ant-')) {
      return res.status(400).json({ error: 'Invalid Anthropic API key — must start with sk-ant-' });
    }

    const ok = ownerKey(req.actor);
    const systemPrompt = await buildSystemPrompt(req.actor);

    // Check for existing agent
    const existing = await db.query(
      'SELECT agent_id, encrypted_key FROM context_integrations WHERE owner_key = $1 AND provider = \'claude_agent\'',
      [ok], 'org-system'
    );

    let agentId, agentUrl;

    if (existing.rows.length && existing.rows[0].agent_id) {
      // Update existing agent system prompt
      agentId = existing.rows[0].agent_id;
      const storedKey = decryptCredential(existing.rows[0].encrypted_key).access_token;
      try {
        await axios.patch(`https://api.anthropic.com/v1/agents/${agentId}`, {
          system: systemPrompt,
        }, {
          headers: {
            'x-api-key': storedKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'managed-agents-2026-04-01',
            'Content-Type': 'application/json',
          },
        });
      } catch {
        // If update fails, try creating a new one
        agentId = null;
      }
    }

    if (!agentId) {
      // Create new agent
      const resp = await axios.post('https://api.anthropic.com/v1/agents', {
        name: 'DeerDawn Context',
        model: { id: 'claude-sonnet-4-6' },
        system: systemPrompt,
        tool: { type: 'agent_toolset_20260401' },
      }, {
        headers: {
          'x-api-key': anthropic_api_key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'managed-agents-2026-04-01',
          'Content-Type': 'application/json',
        },
      });
      agentId = resp.data.id;
      agentUrl = resp.data.url || `https://claude.ai/agents/${agentId}`;
    }

    const encKey = encryptCredential({ access_token: anthropic_api_key });
    await db.query(`
      INSERT INTO context_integrations (integration_id, owner_key, provider, encrypted_key, agent_id, agent_url, updated_at)
      VALUES ($1, $2, 'claude_agent', $3, $4, $5, NOW())
      ON CONFLICT (owner_key, provider) DO UPDATE SET
        encrypted_key = EXCLUDED.encrypted_key,
        agent_id = EXCLUDED.agent_id,
        agent_url = COALESCE(EXCLUDED.agent_url, context_integrations.agent_url),
        updated_at = NOW()
    `, [crypto.randomUUID(), ok, encKey, agentId, agentUrl || null], 'org-system');

    res.json({ agent_id: agentId, agent_url: agentUrl, status: 'active' });
  } catch (err) {
    if (err.response?.status === 401) {
      return res.status(400).json({ error: 'Invalid Anthropic API key' });
    }
    next(err);
  }
});

router.post('/claude-agent/sync', requireContextWrite, async (req, res, _next) => {
  try {
    const ok = ownerKey(req.actor);
    const row = await db.query(
      'SELECT agent_id, encrypted_key FROM context_integrations WHERE owner_key = $1 AND provider = \'claude_agent\'',
      [ok], 'org-system'
    );
    if (!row.rows.length) return res.json({ synced: false, reason: 'no_agent' });

    const { agent_id, encrypted_key } = row.rows[0];
    const apiKey = decryptCredential(encrypted_key).access_token;
    const systemPrompt = await buildSystemPrompt(req.actor);

    await axios.patch(`https://api.anthropic.com/v1/agents/${agent_id}`, {
      system: systemPrompt,
    }, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'managed-agents-2026-04-01',
        'Content-Type': 'application/json',
      },
    });

    await db.query(
      'UPDATE context_integrations SET updated_at = NOW() WHERE owner_key = $1 AND provider = \'claude_agent\'',
      [ok], 'org-system'
    );
    res.json({ synced: true });
  } catch (err) {
    // Non-fatal — log but don't fail
    console.warn('[INTEGRATIONS] Claude agent sync failed:', err.message);
    res.json({ synced: false, reason: err.message });
  }
});

router.delete('/claude-agent', requireContextWrite, async (req, res, next) => {
  try {
    const ok = ownerKey(req.actor);
    await db.query(
      'DELETE FROM context_integrations WHERE owner_key = $1 AND provider = \'claude_agent\'',
      [ok], 'org-system'
    );
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
