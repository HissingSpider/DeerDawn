const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const db = require('../config/db');
const { getLlmConfig } = require('../config/llm');
const { chatCompletion, parseJsonLoose, resolveTimeout } = require('../services/llmClient');
const { ToolSubmissionSchema } = require('../schemas');
const { originGuard } = require('../middleware/originGuard');
const {
  getClientIp,
  isIpAddress,
  resolveRateLimitStore,
  shouldSkipLimiter,
  disableFallback,
} = require('../middleware/rateLimit');
const shareService = require('../services/shareService');
const { buildRepoDigest } = require('../services/repoBriefService');
const briefStashService = require('../services/briefStashService');
const { extractStructuredFields, formatCodeInjection } = require('../../../../packages/shared-context/src/index.js');

const contextPreviewHourly = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const contextPreviewBurst = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
const toolSubmissionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
// The address this share view is FOR, not the address it arrived from.
//
// /s/:token is server-rendered: the marketing app's getServerSideProps fetches
// this route, so every share view in the world reaches the API from one
// address — the renderer's. express-rate-limit's default key is req.ip, so all
// of them shared a single 60/min bucket: one link doing the rounds in a busy
// channel locked out every other link, and hammering one public share page was
// enough to take the whole surface down for everybody. The renderer therefore
// forwards the visitor's address, and the bucket is keyed on that.
//
// The header is only ever trusted to NARROW the bucket, never to escape one: a
// caller that forges it still counts against shareViewPeerLimiter below, on the
// CF-aware, format-validated address the rest of the rate limiting keys on.
const SHARE_CLIENT_IP_HEADER = 'x-deerdawn-client-ip';

// WHO MAY SAY WHOSE ADDRESS THIS IS.
//
// The header was honoured from anybody. A caller hitting the API directly could
// send a different made-up address with every request and get a fresh visitor
// bucket each time; only the peer limiter stood behind it. With
// SHARE_RENDERER_SECRET set, the forwarded address is believed only when the
// request also carries that secret, which the marketing renderer sends from
// getServerSideProps and nobody else has.
//
// UNSET keeps the old behaviour, deliberately, and says so once at boot: the
// secret has to be set in two places (Fly and Vercel), and refusing the header
// in the gap between them would put every visitor back in the renderer's single
// shared bucket — the outage this header was introduced to end.
const SHARE_RENDERER_SECRET_HEADER = 'x-deerdawn-renderer-secret';
let warnedNoRendererSecret = false;

function rendererIsTrusted(req) {
  const expected = process.env.SHARE_RENDERER_SECRET || '';
  if (!expected) {
    if (!warnedNoRendererSecret && process.env.NODE_ENV === 'production') {
      warnedNoRendererSecret = true;
      console.warn('[SHARE] SHARE_RENDERER_SECRET is not set: x-deerdawn-client-ip is trusted from any caller.');
    }
    return true;
  }
  const header = req.headers[SHARE_RENDERER_SECRET_HEADER];
  const presented = Buffer.from(String(Array.isArray(header) ? header[0] : header || ''));
  const wanted = Buffer.from(expected);
  return presented.length === wanted.length && crypto.timingSafeEqual(presented, wanted);
}

function shareVisitorKey(req) {
  const header = req.headers[SHARE_CLIENT_IP_HEADER];
  const forwarded = Array.isArray(header) ? header[0] : header;
  if (isIpAddress(forwarded) && rendererIsTrusted(req)) return `visitor:${forwarded}`;
  return `peer:${getClientIp(req)}`;
}

// Generous enough for a link doing the rounds in a team channel; tight enough
// that the unlisted token space can't be walked by brute force.
const shareViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: resolveRateLimitStore('rl:share-view:'),
  skip: (req) => shouldSkipLimiter(req) || disableFallback,
  keyGenerator: shareVisitorKey,
});

// The flood ceiling behind it, keyed on the address the request actually came
// from. Deliberately loose: in normal operation this is the SSR renderer
// carrying every real visitor, so it must not throttle them — it exists to
// bound a caller that fakes a different visitor address on every request, which
// is the one way past the per-visitor bucket above.
const shareViewPeerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(60, Number(process.env.SHARE_VIEW_PEER_RATE_LIMIT_PER_MINUTE) || 1200),
  standardHeaders: false,
  legacyHeaders: false,
  store: resolveRateLimitStore('rl:share-view-peer:'),
  skip: (req) => shouldSkipLimiter(req) || disableFallback,
  keyGenerator: (req) => `peer:${getClientIp(req)}`,
});

const AI_BRIEF_SYSTEM_PROMPT = `You are a project context extractor. The user will describe their project in plain English. Extract ONLY what is explicitly stated — do not invent, infer, or guess any details that are not directly in the description. Return ONLY a valid JSON object with these fields (omit any field you cannot populate from what was actually said):
{
  "current_task": "string — what they said they are building or implementing",
  "current_status": "string — only if they mentioned status, progress, or blockers; do not invent a percentage",
  "tech_stack": ["only technologies explicitly named"],
  "recent_decisions": ["only decisions explicitly mentioned"],
  "blocking_issue": "string — only if they said something is blocked or pending",
  "description": "string — one sentence summarising the project from what they said",
  "open_questions": ["only questions they explicitly raised"]
}
Return ONLY the JSON object. No markdown, no explanation. Never add information not present in the input.`;

// Separate prompt for the repo path. A repo digest is not a person describing
// their project: it mixes stated fact (the files) with evidence (commit
// subjects), and the difference matters. Presenting an inferred current task as
// something the project declared is the one failure mode that would make this
// tool feel like a hallucination machine to the exact audience it is aimed at.
const AI_REPO_BRIEF_SYSTEM_PROMPT = `You are a project context extractor reading a digest of a public code repository. Return ONLY a valid JSON object with these fields (omit any field you cannot populate):
{
  "current_task": "string — what the project appears to be working on RIGHT NOW, inferred from the recent commit subjects. Phrase it as observed work, e.g. 'Recent work centres on X'. If the commits are too scattered to support one line, omit this field entirely.",
  "current_status": "string — only if the digest supports it. Never invent a percentage.",
  "tech_stack": ["technologies evidenced by the digest: the primary language, topics, and anything named in the files"],
  "recent_decisions": ["conventions, rules and architectural choices STATED in CLAUDE.md, AGENTS.md, .cursorrules or CONTRIBUTING.md. These are the highest-value lines in the digest — prefer them over anything from the README."],
  "blocking_issue": "string — only if the digest explicitly says something is blocked or broken",
  "description": "string — one sentence on what the project is",
  "open_questions": ["only from the open issue titles, and only where the title reads as an unresolved question or decision"]
}

RULES:
- Content under 'STATED IN <file>' is fact. Content under 'RECENT COMMIT SUBJECTS' is evidence to reason from, never a quotation.
- Never claim the project decided something the digest does not say it decided.
- Prefer specific over general: 'Drizzle over Prisma for typed SQL' beats 'uses a database'.
- Omit a field rather than fill it with a generic line. An empty slot is honest; a padded one is not.
Return ONLY the JSON object. No markdown, no explanation.`;

async function aiExtractFields(description, systemPrompt = AI_BRIEF_SYSTEM_PROMPT, maxTokens = 512) {
  // Endpoint, key and model from config/llm.js. 'no_openai_key' keeps its name:
  // the routes below map it to 503 ai_unavailable, as they always have.
  const config = getLlmConfig();
  if (!config.configured) throw new Error('no_openai_key');
  const content = await chatCompletion(
    axios,
    {
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: description },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    },
    { timeoutMs: resolveTimeout(config, 12000), config }
  );
  const raw = content?.trim() || '{}';
  const parsed = parseJsonLoose(raw);
  // Normalise recent_decisions to the shape formatCodeInjection expects
  if (Array.isArray(parsed.recent_decisions)) {
    const decidedAt = new Date().toISOString();
    parsed.recent_decisions = parsed.recent_decisions.map(s =>
      typeof s === 'string' ? { summary: s, decided_at: decidedAt } : s
    );
  }
  return parsed;
}

const router = express.Router();

const PUBLIC_COLUMNS = `
  content_id, content_type, slug, title, description, body_markdown, seo_title,
  seo_description, canonical_path, og_image, tags, category, cta_label,
  cta_href, specialized, published_at, updated_at
`;

const publishedWhere = `
  status = 'published'
  AND published_at IS NOT NULL
  AND published_at <= NOW()
`;

router.get('/', async (req, res) => {
    const type = req.query.type;
    const params = [];
    let typeFilter = '';

    if (type) {
        params.push(type);
        typeFilter = 'AND content_type = $1';
    }

    const result = await db.query(
        `SELECT ${PUBLIC_COLUMNS}
         FROM content_pages
         WHERE ${publishedWhere} ${typeFilter}
         ORDER BY published_at DESC, updated_at DESC
         LIMIT 250`,
        params,
        'org-system'
    );

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({ pages: result.rows });
});

router.get('/sitemap', async (req, res) => {
    const result = await db.query(
        `SELECT content_type, slug, canonical_path, updated_at
         FROM content_pages
         WHERE ${publishedWhere}
         ORDER BY updated_at DESC
         LIMIT 1000`,
        [],
        'org-system'
    );

    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=900');
    res.json({ pages: result.rows });
});

// Public brief share (/s/[token]). Deliberately mounted ABOVE the /:type/:slug
// catch-all below, which would otherwise swallow it as a content page.
//
// No auth by design: the caller is a stranger holding a URL, and the token IS
// the authorisation. No originGuard either — this is meant to be opened from a
// Slack message, a PR description, or a tweet, and it is rendered server-side
// with no Origin header at all.
//
// Never cached at the CDN: revoking a link has to take effect immediately, and a
// shared cache would keep serving a brief the owner has just turned off.
router.get('/share/:token', shareViewPeerLimiter, shareViewLimiter, async (req, res) => {
    try {
        const result = await shareService.getPublicShare(String(req.params.token || ''));
        res.set('Cache-Control', 'no-store');
        if (result.state === 'not_found') return res.status(404).json({ error: 'share_not_found' });
        if (result.state === 'revoked') return res.status(410).json({ error: 'share_revoked' });
        return res.json(result);
    } catch {
        return res.status(500).json({ error: 'share_unavailable' });
    }
});

router.get('/:type/:slug', async (req, res) => {
    const result = await db.query(
        `SELECT ${PUBLIC_COLUMNS}
         FROM content_pages
         WHERE content_type = $1 AND slug = $2 AND ${publishedWhere}
         LIMIT 1`,
        [req.params.type, req.params.slug],
        'org-system'
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({ page: result.rows[0] });
});

router.post('/tools/submissions', toolSubmissionLimiter, async (req, res) => {
    const parsed = ToolSubmissionSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }

    const input = parsed.data;
    const submissionId = crypto.randomUUID();

    await db.query(
        `INSERT INTO tool_submissions (submission_id, tool_type, email, source_route, inputs, outputs)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [submissionId, input.tool_type, input.email || null, input.source_route || null, input.inputs, input.outputs],
        'org-system'
    );

    await db.query(
        `INSERT INTO lead_events (event_id, email, event_type, source_route, source_type, tool_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            crypto.randomUUID(),
            input.email || null,
            'tool_submission',
            input.source_route || null,
            'tool',
            input.tool_type,
            { submission_id: submissionId, inputs: input.inputs, outputs: input.outputs },
        ],
        'org-system'
    );

    res.status(201).json({ success: true, submission_id: submissionId });
});

router.post('/context-preview', originGuard, contextPreviewBurst, contextPreviewHourly, async (req, res) => {
    const parsed = z.object({ text: z.string().min(1).max(20000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });

    const fields = extractStructuredFields(parsed.data.text);
    const brief = formatCodeInjection(fields, 'standard', null);
    const fieldCount = Object.keys(fields).filter(k => {
        const v = fields[k];
        return Array.isArray(v) ? v.length > 0 : Boolean(v);
    }).length;

    // log as lead event (best-effort, no user_id)
    db.query(
        `INSERT INTO lead_events (event_id, event_type, source_route, source_type, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), 'tool_use', '/tools/context-preview', 'tool', { field_count: fieldCount }],
        'org-system'
    ).catch(() => {});

    return res.json({ fields, brief: brief?.body || '', field_count: fieldCount });
});

router.post('/ai-context-brief', originGuard, contextPreviewBurst, contextPreviewHourly, async (req, res) => {
  // 12k, not the original 2k: the input this path is actually for is a real
  // CLAUDE.md / AGENTS.md / README, and a 2k cap truncated most of them
  // mid-file. gpt-4o-mini reads 12k characters for a fraction of a cent, so the
  // old ceiling was buying nothing and costing the use case.
  const parsed = z.object({ description: z.string().min(10).max(12000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });

  try {
    const fields = await aiExtractFields(parsed.data.description);
    const brief = formatCodeInjection(fields, 'standard', null);
    const fieldCount = Object.keys(fields).filter(k => {
      const v = fields[k];
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    }).length;

    db.query(
      `INSERT INTO lead_events (event_id, event_type, source_route, source_type, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), 'tool_use', '/tools/context-preview', 'tool', { field_count: fieldCount, mode: 'ai' }],
      'org-system'
    ).catch(() => {});

    return res.json({ fields, brief: brief?.body || '', field_count: fieldCount });
  } catch (err) {
    if (err.message === 'no_openai_key') return res.status(503).json({ error: 'ai_unavailable' });
    return res.status(500).json({ error: 'generation_failed' });
  }
});

// Park the briefs an anonymous visitor built at /tools/context-preview so they
// can survive the cross-origin hop to app.deerdawn.com at signup. Returns an
// opaque token, not the briefs, so nothing sensitive rides in the redirect URL.
router.post('/brief-stash', originGuard, contextPreviewBurst, contextPreviewHourly, async (req, res) => {
  const parsed = z.object({
    briefs: z.array(z.object({
      label: z.string().max(200).optional(),
      fields: z.record(z.unknown()).optional(),
      source: z.record(z.unknown()).optional(),
    })).min(1).max(briefStashService.MAX_BRIEFS),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });

  try {
    const { token, count } = await briefStashService.createStash(parsed.data.briefs);
    return res.json({ stash_token: token, count });
  } catch (err) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    // A stash we could not store must not hand back a token — the token would
    // be a promise the claim step cannot keep.
    return res.status(503).json({ error: 'stash_unavailable' });
  }
});

// Level-0 surface: a public GitHub URL in, the four brief slots out, with no
// account and nothing installed. Shares the preview rate limiters — the GitHub
// side is additionally protected by a 6h digest cache, so a repo doing the
// rounds costs one set of API calls rather than one per visitor.
router.post('/repo-brief', originGuard, contextPreviewBurst, contextPreviewHourly, async (req, res) => {
  const parsed = z.object({ repo_url: z.string().min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });

  try {
    const { digest, source, cached } = await buildRepoDigest(parsed.data.repo_url);
    const fields = await aiExtractFields(digest, AI_REPO_BRIEF_SYSTEM_PROMPT, 700);
    const brief = formatCodeInjection(fields, 'standard', null);
    const fieldCount = Object.keys(fields).filter(k => {
      const v = fields[k];
      return Array.isArray(v) ? v.length > 0 : Boolean(v);
    }).length;

    db.query(
      `INSERT INTO lead_events (event_id, event_type, source_route, source_type, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        crypto.randomUUID(),
        'tool_use',
        '/tools/context-preview',
        'tool',
        { field_count: fieldCount, mode: 'repo', repo: `${source.owner}/${source.repo}`, digest_cached: cached },
      ],
      'org-system'
    ).catch(() => {});

    // Provenance is part of the product here, not debug output: showing which
    // files the brief came from is what separates this from a page that could
    // have made the whole thing up.
    return res.json({
      fields,
      brief: brief?.body || '',
      field_count: fieldCount,
      source: {
        owner: source.owner,
        repo: source.repo,
        ref: source.ref,
        files_read: source.files.map(f => f.path),
        commits_read: source.commits.length,
        issues_read: source.issues.length,
        stars: source.meta.stars,
        archived: source.meta.archived,
      },
    });
  } catch (err) {
    if (err.message === 'no_openai_key') return res.status(503).json({ error: 'ai_unavailable' });
    // The GitHub-side failures are all things the visitor can act on, so they
    // keep their own codes rather than collapsing into a generic 500.
    if (err.status && err.status !== 500) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: 'generation_failed' });
  }
});

module.exports = router;
// Exported for the unit test: the share-view bucket key is the whole fix, and
// asserting it through a booted server would need the DB this route does not.
module.exports.shareVisitorKey = shareVisitorKey;
module.exports.SHARE_CLIENT_IP_HEADER = SHARE_CLIENT_IP_HEADER;
