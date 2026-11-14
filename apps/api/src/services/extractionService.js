const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const store = require('../store/contextSyncStore');
const { normalizeText, isVagueDecision } = require('./contextQualityGuards');
const workspace = require('./workspaceService');
const folderRule = require('./folderRule');
const { getLlmConfig } = require('../config/llm');
const { chatCompletion, parseJsonLoose, resolveTimeout } = require('./llmClient');
const {
  ExtractionResponseSchema,
} = require('../../../../packages/shared-context/src/index.js');

// Provider config — set EXTRACTION_PROVIDER=anthropic to switch.
// The default is any OpenAI-compatible endpoint, whose URL, key and model come
// from config/llm.js (LLM_API_URL / LLM_API_KEY / LLM_MODEL; with only
// OPENAI_API_KEY set that is api.openai.com and gpt-4o-mini, as before).
// Anthropic uses claude-haiku with prompt caching.
const PROVIDER = (process.env.EXTRACTION_PROVIDER || 'openai').toLowerCase();

const PROVIDERS = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
};

// Only the native Anthropic provider keeps a config here; every other value of
// EXTRACTION_PROVIDER means the OpenAI-compatible endpoint, as it always did.
const IS_ANTHROPIC = PROVIDER === 'anthropic';
const PROVIDER_CONFIG = IS_ANTHROPIC ? PROVIDERS.anthropic : null;

// The credential gate, read at call time. For the OpenAI-compatible endpoint a
// keyless custom LLM_API_URL (Ollama, LM Studio) counts as configured; the
// default OpenAI URL with no key is the "no extractor" state it always was.
function extractorCredential() {
  if (IS_ANTHROPIC) {
    const key = process.env[PROVIDER_CONFIG.apiKeyEnv];
    return { ok: Boolean(key), key, missing: PROVIDER_CONFIG.apiKeyEnv };
  }
  const config = getLlmConfig();
  return { ok: config.configured, config, missing: 'LLM_API_KEY/OPENAI_API_KEY' };
}

const EXTRACTION_TIMEOUT_MS = 15_000;

// The OpenAI-compatible request. Field order and values are exactly what was
// sent before this was configurable; response_format stays, and llmClient
// retries once without it for a server that rejects it.
function buildOpenAiRequest(config, userMessage) {
  return {
    model: config.model,
    max_tokens: 640,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  };
}
const SEED_TIMEOUT_MS = 20_000;
const RATE_GUARD_MS = 30_000;

// Per-project rate guard: Map<prefixed-key, { lastAt, cachedResponse }>
const rateGuard = new Map();

// Evict rate guard entries older than 5 minutes every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, val] of rateGuard.entries()) {
    if (val.lastAt < cutoff) rateGuard.delete(key);
  }
}, 10 * 60 * 1000).unref();

const SYSTEM_PROMPT = `You are a context extraction engine for Deerdawn, AI session memory that briefs every new AI session with your project's current state.
Given a conversation chunk and the user's existing project context, identify what has changed or been decided.
Return ONLY valid JSON matching this exact schema — no markdown, no extra text:
{
  "match_decision": "matched_existing" | "new_project" | "ambiguous" | "ignored",
  "confidence": number between 0 and 1,
  "project_candidate": { "project_name": string, "reason": string, "score": number } | null,
  "delta": {
    "category"?: "coding" | "topic",
    "description"?: string,
    "goals"?: string[],
    "current_status"?: string,
    "current_task"?: string,
    "tech_stack"?: string[],
    "file_structure_summary"?: string[],
    "open_questions"?: string[],
    "resolved_questions"?: string[],
    "resolved_decisions"?: string[],
    "completed_goals"?: string[],
    "completed_work"?: string[],
    "recurring_context"?: string[],
    "recent_decisions"?: [{"summary": string, "headline"?: string, "reasoning"?: string, "decided_at": "<ISO8601>", "importance": "low" | "normal" | "high" | "critical"}],
    "landmines"?: [{"summary": string, "paths"?: string[], "added_at": "<ISO8601>", "importance": "low" | "normal" | "high" | "critical"}],
    "blocking_issue"?: string,
    "task_progress"?: string,
    "next_action"?: string,
    "task_steps"?: [{"name": string, "status": "todo" | "in_progress" | "done"}],
    "commands"?: [{"label": string, "run": string, "note"?: string}]
  },
  "should_create_project": boolean,
  "needs_user_confirmation": boolean,
  "no_material_change": boolean
}
Rules:
- Only populate delta fields where there is genuinely new or changed information.
- If the new chunk does not materially change project context, set no_material_change to true and leave delta empty.
- DeerDawn tracks BOTH software projects AND non-coding life topics (a trip, a move, an event, a health or fitness plan, a major purchase, an ongoing personal project). Set "category" to "coding" for software/engineering/professional work, or "topic" for a non-coding life context. A conversation that has an ongoing, trackable subject the user will return to — even a personal one like planning a Mount Shasta climb — IS worth capturing as a "topic": set category to "topic" and populate the delta as you would for any project (description, goals, current_status, current_task, open_questions, recent_decisions all apply).
- Only set match_decision to "ignored" (with no_material_change true, confidence 0) for genuinely contextless chatter with no durable subject to track: one-off trivia, idle small talk, a single weather or math question, or a throwaway exchange the user has no reason to resume. When in doubt about a coherent ongoing subject, prefer capturing it as a "topic" over ignoring it.
- If you are uncertain which project this belongs to, set needs_user_confirmation to true.
- Be conservative: only update fields when high confidence (>0.8). Never fabricate information.
- For decided_at, use today's date (provided at the top of the user message) unless the conversation explicitly references a past date for the decision.
- For recent_decisions, extract any technology choice, approach preference, or implementation trade-off mentioned in the conversation — even if phrased informally (e.g. "let's use X for now", "we'll go with Y", "X over Z because"). Always include "importance". Use "critical" for architectural choices, security decisions, or anything that would cause rework if forgotten (e.g. "we dropped the old auth system", "we switched to a monorepo"). Use "high" for significant trade-offs with lasting impact. Use "normal" for standard implementation choices. Use "low" for incidental or easily reversible decisions.
- For recent_decisions, populate reasoning only when the conversation explicitly states WHY (e.g. "we chose X because Y can't do Z").
- For recent_decisions, always write a "headline": the claim in ONE line, under 160 characters, readable on its own by someone who was not in this conversation and does not know this project. It is quoted into OTHER projects' briefs, so it must carry its own subject — "the allocator's covariance must come from out-of-sample returns", never "we fixed it" or "changed the approach". State the claim, not the activity: no "decided to", no "updated the", no project name prefix. If the decision names a file, symbol or number that makes it checkable, keep that in the headline over any adjective.
- landmines = sharp, durable WATCH-OUTS that cause breakage or rework if forgotten: footguns, fragile invariants, dead code, things that already bit someone (e.g. "the normalizer at L964 silently drops any field not explicitly preserved", "don't run the migration twice — it's not idempotent", "auth defaults to admin role"). A landmine is distinct from open_questions (which are unanswered questions) and from recent_decisions (which are choices that were made). Set importance "critical" for data-loss or security footguns. Only extract concrete, specific watch-outs — never vague advice like "be careful" or "watch out for bugs". Do NOT duplicate a recurring_context constraint as a landmine. For added_at use today's date.
- For open_questions, extract unresolved questions, pending decisions, and next decision points the user or assistant explicitly identifies. Include phrases like "we still need to decide X", "open question: X", "need to figure out X", "pending decision: X", and "should we do X or Y?" when no answer is provided in the same conversation.
- Do not put answered questions in open_questions. If the same conversation answers a pending question, put the original question in resolved_questions and the answer in recent_decisions.
- Prefer decision-oriented wording for pending choices, e.g. "Decide whether question tracking belongs in extraction or structured events" instead of copying a long conversational sentence.
- Keep open_questions actionable and concise. Each item should be answerable by a future user or agent.
- Populate blocking_issue only when there is a concrete obstacle preventing progress (e.g. "can't proceed until X is fixed", "blocked on Y").
- Set blocking_issue to empty string ("") when the conversation indicates a previously blocking issue has been resolved, fixed, verified, or no longer applies — phrases like "blocker cleared", "unblocked", "verified green", "shipped", "fixed and deployed", "production promotion unblocked". Omit blocking_issue entirely if you are uncertain.
- Populate task_progress only when there is an explicit progress signal (e.g. "about 60% done", "just the auth part left", "3 of 5 files complete").
- Populate next_action with ONE next step only when the conversation itself names it: the user said it, or the user agreed to it when it was proposed (e.g. "next I'll run the credential migration against staging", "tomorrow: call the landlord"). It lets a later session resume at the exact cursor, so copy the step as said; keep it to one actionable step. Never infer, suggest or invent a next step the conversation did not state, and omit it when the task is complete or no next step was named.
- Populate task_steps when the conversation explicitly names discrete steps or sub-tasks, or describes partial completion across named parts (e.g. "done the store changes, still need the route and tests"). List each named step with status "done", "in_progress", or "todo". The step currently being worked on gets "in_progress". Do not infer steps — only capture ones explicitly named or described. Replace the entire array when updating (wholesale replace, not append).
- Populate resolved_questions with the text of any open question that was answered or decided in this conversation. Use fuzzy matching — copy the question text closely enough that it can be matched against existing questions.
- Populate resolved_decisions with the title or key phrase of any previously logged decision that has now been fully implemented, fixed, deployed, or is explicitly no longer relevant. Examples: "MCP setup UX issues fixed", "auth crash on startup resolved", "rate limit raised". Use a short phrase that fuzzy-matches the original decision title. Only populate this when the conversation confirms the decision has been acted on — not just when it is discussed.
- Populate completed_goals with the text of any goal that was shipped, finished, or explicitly marked done. Same fuzzy matching rule applies.
- Populate completed_work with a short past-tense summary of each concrete piece of work the conversation reports as finished, shipped, fixed, merged, deployed, or verified (e.g. "Fixed the GOOGLE_ADS_CUSTOMER_ID in Fly secrets", "Merged PR #195 and deployed to prod"). This is the SHIPPED feed — it is ADDITIVE and distinct from completed_goals (which only removes a matching tracked goal): capture the completion even when it was never a tracked goal. One entry per discrete completion, concise. Omit entirely when nothing was actually finished in this chunk — never pad it with in-progress or planned work.
- Populate current_task with a clear, specific next action — not a vague description. Prefer "Implement rate limiting on /api/v1/extraction" over "Working on API".
- NEVER derive current_task, next_action, or blocking_issue from something the author explicitly dismisses or marks as out of scope. Phrases like "unrelated", "pre-existing", "not the task", "ignore this", "out of scope", "separate issue", "leave that for later", or "X is failing but that's expected/unrelated" mean X is NOT the current task. A negated or dismissed mention must never become the forward task. Example: "the 3 remaining failures are pre-existing tests, unrelated" → do NOT set current_task to "fix the failing tests".
- When the conversation is a completion report — the described work is finished, shipped, fixed, merged, or verified, with no new forward task named — do NOT invent a current_task. Set current_status to reflect the completion and OMIT current_task entirely so the prior task is left untouched (it can be closed via the explicit task_completed event instead). Only set a new current_task when the conversation genuinely names the next thing to do.
- Populate commands when the conversation mentions a specific command the user runs for a repeatable task (deploy, test, start, build, etc.). Use short labels: "deploy", "test", "start". Only extract commands explicitly mentioned — never infer.
- Never record who the user is: no personal expertise, long-term goals, working style, values or communication style. Everything you extract belongs to this project. The user's own profile is something they write themselves.`;

const SAFE_FALLBACK = {
  match_decision: 'ambiguous',
  confidence: 0,
  delta: {},
  should_create_project: false,
  needs_user_confirmation: true,
  no_material_change: false,
  routing_state: 'ambiguous',
};

const TRIVIAL_NOISE_PATTERNS = [
  /^ok(?:ay)?(?:\s+thanks)?[.!]*$/i,
  /^thanks?(?:\s+you)?[.!?]*$/i,
  /^sounds good[.!]*$/i,
  /^got it[.!?]*$/i,
  /^continue[.!]*$/i,
  /^(?:yes|no|yep|nope|yup|nah)[.!?]*$/i,
  /^(?:sure|fine|great|perfect|nice|cool|awesome)[.!?]*$/i,
  /^(?:k|ty|thx|lol|lmao|haha|heh)[.!]*$/i,
  /^[👍👌✅🙏😊👏🎉🔥💯]+$/u,
  /^[.!?…]+$/,
  /^\d+$/,
  /^(?:same|agreed|noted|understood|correct|exactly|right)[.!?]*$/i,
  /^(?:please|go ahead|proceed)[.!]*$/i,
];

function getActorKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

function clipText(text, maxChars) {
  const value = String(text || '').trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trim()}...`;
}

function approximateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function tokenize(text) {
  return normalizeText(text)
    .split(/[^a-z0-9_./:-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 128);
}

// Common words that carry no topic identity — excluded from the topic-name anchor
// so a topic like "The Move" or "Vacation" can't hijack an unrelated conversation
// that merely contains those words.
const TOPIC_NAME_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'plan', 'planning', 'trip', 'this', 'that', 'about',
  'into', 'from', 'your', 'our', 'their', 'will', 'need', 'want', 'project', 'topic',
  'move', 'stuff', 'thing', 'things', 'new', 'day', 'days', 'week', 'time',
]);

function chunksFromInput(input) {
  return input.chunks?.length ? input.chunks : input.chunk ? [input.chunk] : [];
}

function renderChunks(chunks) {
  return chunks
    .map((chunk) => `[${chunk.role}] ${chunk.text}`)
    .join('\n');
}

function isTrivialConversation(chunks) {
  const normalized = normalizeText(chunks.map((chunk) => chunk.text).join(' '));
  if (!normalized) return true;
  // Short AND no meaningful token (word > 4 chars with substance)
  if (normalized.length <= 20 && !normalized.split(/\s+/).some((w) => w.length > 4 && /[a-z]{3,}/i.test(w))) return true;
  return TRIVIAL_NOISE_PATTERNS.some((pattern) => pattern.test(normalized));
}

// The session's working directory as a comparable path: lowercased, forward
// slashes, no trailing slash. Empty when the capture carries no cwd.
function sessionCwdPath(input, session) {
  return normalizeText(input.session_context?.cwd || session?.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

// The repository the capture came from, as the client derived it from git
// (packages/mcp-server getWorkspaceKey: `remote:<normalized origin>`, else
// `root:<repo directory name>`) and sent as session_context.workspace_key. A
// project carries the same key from its creation or its first write that had
// one. Null outside a repository, or from a caller that sends none.
function captureRepositoryIdentity(input) {
  const key = input.session_context?.workspace_key;
  return typeof key === 'string' && key ? key : null;
}

// THE FOLDER RULE IS services/folderRule.js, and it is the same rule the
// resolver (resolveActiveProject) reads, so a capture and start_session cannot
// disagree about which project a directory is. A project owns the capture's
// directory when the directory IS a linked path, is below one in the SAME
// repository (both identities known and equal), or is the same repository with
// no path linked. A linked directory that merely sits ABOVE the capture, in a
// different or unknown repository, owns nothing: it is a guess, read with a
// warning by the resolver and never written to. Letting it be one filed every
// repository under a linked home directory into the project that ~ happened to
// be linked to, rewrote that project's brief, and then linked each repository
// to it for good.
function captureFolder(input, session) {
  return { cwd: sessionCwdPath(input, session), workspaceKey: captureRepositoryIdentity(input) };
}

// `folderOwnerId` is the one project the folder rule says owns the capture's
// directory (folderRule.writeTargetForFolder: the pinned sub-project, else the
// best project whose links or repository identity own it), null when none does.
// Only that project is anchored by the directory.
//
// `anchorsQualify` false is the routing a session that carries a binding gets:
// every OWNING linked path is worth 1.1, none shadows another, and nothing
// is `anchored`, so candidates qualify on `qualifying` alone. That is how every
// capture was routed before anchors qualified alone. See resolveHeuristicMatch.
function scoreProjectMatch(project, session, input, terms, { folderOwnerId = null, anchorsQualify = true } = {}) {
  const candidateTexts = [
    project.project_name,
    ...(project.aliases || []),
    project.context?.current_task,
    project.context?.current_status,
    ...(project.context?.tech_stack || []),
    ...(project.context?.file_structure_summary || []),
    ...(project.linked_paths || []),
    ...(project.linked_conversations || []),
  ].filter(Boolean).map(normalizeText);
  const cwd = normalizeText(input.session_context?.cwd || session?.cwd || '');
  const conversationRef = normalizeText(input.session_context?.conversation_ref || session?.conversation_ref || '');
  const host = normalizeText(input.session_context?.host || session?.host || '');
  let score = 0;
  // What the directory's NAME contributes, kept apart from the rest: it may rank
  // candidates, and it may never be what qualifies one. See resolveHeuristicMatch.
  let nameResemblance = 0;

  // The three ANCHORS: facts that tie this session to this project, as opposed
  // to text that resembles it.
  const bound = Boolean(session?.project_id) && session.project_id === project.project_id;
  if (bound) score += 1.4;
  // A directory inside nested linked paths that own it (a monorepo root and a
  // package in it) is claimed by the DEEPEST of them, the same project
  // start_session opens there (the resolver ranks the deepest owning path
  // first). The shallower project is not anchored by it: counting both let the
  // umbrella's vocabulary take a capture made inside the package.
  const claim = folderRule.folderClaim(project, captureFolder(input, session));
  const insideLinkedPath = anchorsQualify && folderOwnerId === project.project_id;
  if (insideLinkedPath) score += 1.1;
  // A bound session is routed as it always was: every linked path that owns the
  // directory is worth 1.1 toward the threshold, so it still needs vocabulary on
  // top. A linked path ABOVE a different or unknown repository is worth nothing:
  // it is a guess and never writes.
  else if (!anchorsQualify && claim.ownDepth >= 0) score += 1.1;
  const linkedConversation = Boolean(conversationRef)
    && (project.linked_conversations || []).some((ref) => conversationRef === normalizeText(ref));
  if (linkedConversation) score += 1.1;
  if (cwd) {
    const repoName = normalizeText(path.basename(cwd));
    if (repoName && candidateTexts.some((text) => text.includes(repoName))) nameResemblance = 0.45;
  }
  if (host && candidateTexts.some((text) => text.includes(host))) score += 0.2;

  const overlap = terms.reduce((count, term) => (
    candidateTexts.some((text) => text.includes(term)) ? count + 1 : count
  ), 0);
  score += Math.min(1, overlap / Math.max(1, terms.length)) * 0.9;

  // Cross-platform topic convergence: a web/life topic has no cwd or path signal,
  // so the same conversation on ChatGPT vs Claude would otherwise never cross the
  // match threshold and would spawn a duplicate topic per platform. The primary
  // anchor for a topic is its NAME (+ aliases) appearing in the conversation —
  // when most of the topic's name terms are present, treat it as a strong match.
  if (project.context?.category === 'topic') {
    const nameTokens = Array.from(new Set(
      tokenize([project.project_name, ...(project.aliases || [])].join(' '))
        .filter((token) => !TOPIC_NAME_STOPWORDS.has(token))
    ));
    const present = nameTokens.filter((token) => terms.includes(token)).length;
    const nameMatch = nameTokens.length ? present / nameTokens.length : 0;
    // A strong topic-name match is a confident cross-platform anchor on its own —
    // clear the match threshold (1.25) even with no other signal. BUT require at
    // least two distinct meaningful name tokens present, so a single common word
    // ("vacation", "the move") can never force-merge an unrelated conversation.
    if (nameTokens.length >= 2 && present >= 2 && nameMatch >= 0.6) score += 1.3;
    else if (nameMatch > 0) score += nameMatch * 0.6;
  }
  // `qualifying` is what has to clear the match threshold, unless the project is
  // `anchored`, which qualifies it outright; `score` (with the directory-name
  // resemblance added back) only orders candidates that qualified.
  return {
    score: score + nameResemblance,
    qualifying: score,
    anchored: anchorsQualify && (bound || insideLinkedPath || linkedConversation),
  };
}

function buildAmbiguousHeuristicResult(project, reason, routingState = 'ambiguous') {
  return {
    match_decision: 'ambiguous',
    confidence: 0.5,
    project_candidate: project ? {
      project_id: project.project_id,
      project_name: project.project_name,
      reason,
      score: 0.5,
    } : undefined,
    delta: {},
    should_create_project: false,
    needs_user_confirmation: true,
    no_material_change: true,
    routing_state: routingState,
    suppression_reason: reason,
  };
}

async function resolveHeuristicMatch(actor, input, chunks) {
  try {
    const ownerKey = getActorKey(actor);
    const session = input.session_id ? await store.getSession(ownerKey, input.session_id) : null;
    // Scoped to what this actor may see: a heuristic match must never nominate
    // (or echo the name of) a teammate's personal project.
    const projects = await store.listProjects(ownerKey, {
      actorIdentities: workspace.actorIdentities(actor),
      isWorkspaceOwner: (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner',
    });
    if (!projects.length) return null;

    const terms = tokenize([
      input.session_context?.cwd,
      input.session_context?.conversation_ref,
      input.session_context?.host,
      renderChunks(chunks),
    ].filter(Boolean).join(' '));

    // A DIRECTORY'S NAME DOES NOT QUALIFY A WRITE TARGET.
    //
    // The result of this function is where applyExtraction FILES the delta. One
    // of its signals is "some text of the project contains the basename of the
    // cwd" (0.45): a repo called `api` resembles "Acme API", "Rapid prototype"
    // and "Therapist notes" alike. Added to a host substring (0.2) and shared
    // vocabulary (up to 0.9) it cleared the 1.25 threshold with no fact tying
    // the session to the project — not bound there, not inside a linked path,
    // not the same conversation — and the capture was written into it.
    //
    // So the threshold is judged on `qualifying`, which leaves that resemblance
    // out. For a code project with no anchor the rest (host 0.2, vocabulary
    // 0.9) tops out at 1.1, below the threshold. A topic can still qualify on
    // its name and content, which is the deliberate cross-platform convergence
    // above and has no directory in it. The resemblance still ORDERS candidates
    // that qualified, and one that did not qualify cannot raise a false
    // stale_binding.
    //
    // AND A REAL ANCHOR QUALIFIES BY ITSELF. The same arithmetic that kept
    // resemblance out kept the anchors out too: inside a linked path is exactly
    // 1.1, a linked conversation 1.1, and neither cleared 1.25 without enough
    // shared vocabulary on top. The Stop-hook flush is a capture of NEW work,
    // which is precisely the text that shares little with what the project
    // already stores, so a repo that was linked to its project matched nothing,
    // the model named a project after the conversation, and the capture was
    // filed into a stray one. The next session in that repo had none of it.
    // Vocabulary, host and resemblance RANK anchored candidates; apart from a
    // topic's name convergence, they qualify nothing. "Inside a linked path"
    // is an anchor only where it is a tie to the same repository (see
    // folderRule); a linked directory ABOVE a different or unknown
    // repository scores as it always did and qualifies nothing alone.
    //
    // ONLY FOR A SESSION THAT IS NOT BOUND. A bound session is answered exactly
    // as it was before anchors qualified alone. With them, a session bound to
    // one project and working in another project's linked directory got that
    // project qualified on its directory, where the ranking score (1.1 plus
    // the 0.45 resemblance its own linked path always earns) beat the binding's
    // 1.4, and stale_binding, which writes nothing, dropped the capture that
    // used to be written into the bound project. What SHOULD happen there is
    // an open question; until it is answered it routes as it always did. A
    // binding to a project that is archived or can no longer be read is still
    // a binding here, for the same reason: giving the directory an anchor
    // against it would raise a stale_binding that was never raised before. The
    // Stop-hook flush this was all for arrives on a session that is not bound.
    const MATCH_THRESHOLD = 1.25;
    const anchorsQualify = !session?.project_id;
    const folder = captureFolder(input, session);
    // The pin the person set for this repository wins over location, exactly as
    // it does for start_session. Only asked for a session that is not bound: a
    // bound session never anchors on its folder.
    const pinnedProjectId = anchorsQualify && folder.workspaceKey
      ? await store.getWorkspacePointer(ownerKey, folder.workspaceKey, workspace.actorIdentities(actor)).catch(() => null)
      : null;
    const folderOwnerId = anchorsQualify
      ? folderRule.writeTargetForFolder(projects, folder, { pinnedProjectId })?.project?.project_id || null
      : null;
    const ranked = projects
      .map((project) => ({ project, ...scoreProjectMatch(project, session, input, terms, { folderOwnerId, anchorsQualify }) }))
      .filter((entry) => entry.anchored || entry.qualifying >= MATCH_THRESHOLD)
      .sort((left, right) => right.score - left.score);

    const top = ranked[0];
    if (session?.project_id && top?.project?.project_id && top.project.project_id !== session.project_id) {
      return buildAmbiguousHeuristicResult(top.project, 'stale_binding', 'stale_match');
    }
    // Everything still in `ranked` cleared the threshold.
    if (!top) return null;

    return {
      match_decision: 'matched_existing',
      confidence: Math.min(0.99, Number((0.55 + top.score / 4).toFixed(2))),
      project_candidate: {
        project_id: top.project.project_id,
        project_name: top.project.project_name,
        reason: session?.project_id === top.project.project_id
          ? 'Strong session affinity from prior binding'
          : 'Strong workspace and context overlap with an existing project',
        score: Math.min(0.99, Number((top.score / 3).toFixed(2))),
      },
      // Empty BECAUSE THIS FUNCTION DOES NOT LOOK AT CONTENT. It answers where a
      // chunk belongs, never whether there is anything in it worth storing.
      // runExtraction must treat a 'matched_existing' return as routing only and
      // go on to extract; returning it as the whole answer is what made every
      // update from an already-bound session a silent no-op. See the guard on
      // isRoutingOnly below.
      delta: {},
      should_create_project: false,
      needs_user_confirmation: false,
      // Only true until an extraction has actually looked. Kept on the object so
      // this remains a usable terminal result on the paths where no extraction
      // can run (no API key, provider down) — there, empty really is all we have.
      no_material_change: true,
      routing_state: 'matched',
    };
  } catch (err) {
    console.warn('[EXTRACTION] Heuristic matching failed:', err.message);
    return null;
  }
}

// Routing for a caller that named its project: the same shape the heuristic
// returns for a match, so everything downstream treats the two alike. Null when
// the actor cannot read that project, which leaves the decision to
// applyExtraction's own write gate rather than echoing a name they may not see.
async function buildExplicitRouting(actor, projectId) {
  try {
    const service = require('./contextSyncService');
    const project = await service.getProject(actor, projectId);
    if (!project) return null;
    const routing = {
      match_decision: 'matched_existing',
      confidence: 0.99,
      project_candidate: {
        project_id: project.project_id,
        project_name: project.project_name,
        reason: 'Project named by the caller',
        score: 0.99,
      },
      delta: {},
      should_create_project: false,
      needs_user_confirmation: false,
      no_material_change: true,
      routing_state: 'matched',
    };
    // Carried so runExtraction does not load the same project (and its event
    // log) a second time for the digest. Non-enumerable: it is not part of the
    // routing answer and must never be spread into a response.
    Object.defineProperty(routing, 'existingContext', { value: project.context || null, enumerable: false });
    return routing;
  } catch (err) {
    console.warn('[EXTRACTION] Explicit routing failed:', err.message);
    return null;
  }
}

/**
 * Does this heuristic result answer only WHERE, leaving WHAT still open?
 *
 * 'matched_existing' does: the project is settled and extraction should run.
 * 'ambiguous' (including the stale-binding case) does NOT — we do not know which
 * project a delta would land in, so producing one would be worse than producing
 * none, and that result is terminal on purpose.
 */
function isRoutingOnly(heuristic) {
  return Boolean(heuristic) && heuristic.match_decision === 'matched_existing';
}

/**
 * Keep the heuristic's ROUTING, keep the model's CONTENT.
 *
 * The model is asked what changed, not where it goes: it sees a digest of one
 * project, so its own match_decision is a guess made without the workspace in
 * front of it, and letting it override a high-confidence session binding is how
 * an update lands in the wrong project (or spawns a duplicate).
 *
 * `confidence` stays the MODEL's, deliberately, even though match_decision comes
 * from the heuristic. That field is what sanitizeExtraction's
 * WRITE_CONFIDENCE_FLOOR gates the delta on, so it has to describe how sure we
 * are of the CONTENT. Taking the routing confidence there would let a strong
 * project match wave a weak extraction into the durable vault. The routing
 * confidence is not lost — it is carried on project_candidate.score.
 */
function applyHeuristicRouting(extracted, heuristic) {
  if (!isRoutingOnly(heuristic)) return extracted;
  // `ignored` is a verdict about CONTENT, and content is the model's to judge.
  // Overwriting it with the heuristic's 'matched_existing' told every caller
  // that chatter was a real update with nothing extracted, which is exactly the
  // condition the update_context floor then stored at high importance. The
  // project is still carried, so a caller that wants to know where the chunk
  // belonged can read it.
  if (extracted?.match_decision === 'ignored') {
    return {
      ...extracted,
      project_candidate: heuristic.project_candidate,
      should_create_project: false,
      needs_user_confirmation: false,
    };
  }
  return {
    ...extracted,
    match_decision: heuristic.match_decision,
    project_candidate: heuristic.project_candidate,
    should_create_project: false,
    needs_user_confirmation: false,
    routing_state: heuristic.routing_state || 'matched',
  };
}

function buildContextDigest(context) {
  if (!context || !context.project_name) {
    return '(no existing context — this may be a new project)';
  }

  const decisions = (context.recent_decisions || []).slice(-2).map((item) => {
    return item.reasoning ? `${item.summary} (because: ${item.reasoning})` : item.summary;
  }).filter(Boolean);
  const constraints = (context.recurring_context || []).slice(0, 2);
  const fingerprint = JSON.stringify({
    project_name: context.project_name || '',
    current_task: context.current_task || '',
    current_status: context.current_status || '',
    decisions,
    constraints,
  });

  return [
    `Project: ${context.project_name}`,
    context.current_task && `Current task: ${clipText(context.current_task, 120)}`,
    context.blocking_issue && `Blocking: ${clipText(context.blocking_issue, 80)}`,
    context.task_progress && `Progress: ${clipText(context.task_progress, 80)}`,
    context.current_status && `Current status: ${clipText(context.current_status, 120)}`,
    decisions.length > 0 && `Recent decisions: ${decisions.map((item) => clipText(item, 80)).join(' | ')}`,
    constraints.length > 0 && `Recurring constraints: ${constraints.map((item) => clipText(item, 60)).join(' | ')}`,
    `Context fingerprint: ${Buffer.from(fingerprint).toString('base64').slice(0, 20)}`,
  ].filter(Boolean).join('\n');
}

// Normalize LLM output before Zod validation:
// - Strips empty-string delta fields so they don't overwrite real context with ""
// - Converts invalid/missing decided_at values to a valid ISO8601 datetime
// blocking_issue is intentionally excluded: "" is a valid clear signal (blocker resolved).
// All others treat "" as "omit" to avoid the LLM vacuously wiping prose fields.
const DELTA_STRING_FIELDS = ['description', 'current_status', 'current_task', 'source_summary', 'task_progress', 'next_action'];

// Strip task_progress from extraction output unless it's a real partial-progress signal.
// Prevents the LLM from setting task_progress="completed" when it sees status phrases like
// "deploy complete" or "shipped" — those belong in current_status, not task_progress.
// The explicit task_completed structured event (contextSyncService) still sets it correctly.
function sanitizeTaskProgress(output) {
  const delta = output?.delta;
  if (!delta || !delta.task_progress) return output;
  const tp = String(delta.task_progress).trim();
  const isRealProgress = (
    /\d+\s*%/.test(tp) ||
    /\d+\s*(of|\/)\s*\d+/i.test(tp) ||
    /step\s+\d+/i.test(tp)
  );
  if (!isRealProgress) {
    const { task_progress: _, ...rest } = delta;
    return { ...output, delta: rest };
  }
  return output;
}

const BOARD_DIRECTIVE_KEYS = ['add_todos', 'remove_todos', 'complete_todos', 'move_todos'];

// The prompt tells the model to use "today's date", and a model told a date
// answers with a date: "2026-09-19", not an ISO datetime. That was rejected as
// invalid, restamped `now` and flagged date_inferred — so a correctly dated
// decision was demoted below every other one. A bare date is a real date: take
// it as noon UTC, which stays on the same calendar day in every timezone.
function normalizeModelDate(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T12:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (!text.includes('T')) return null;
  const parsed = new Date(text);
  // Re-serialised, because the schema wants a Z-suffixed datetime and the model
  // sometimes sends an offset one.
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sanitizeLlmOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const now = new Date().toISOString();
  const out = { ...parsed };
  if (out.delta && typeof out.delta === 'object') {
    const delta = { ...out.delta };
    // The model is never asked who the user is, and if it says anyway the
    // answer is dropped here: the profile is the person's own word, not
    // something read out of a project (see sanitizeExtraction).
    delete delta.you_profile;
    // Strip empty strings — treat "" the same as omitting the field
    for (const field of DELTA_STRING_FIELDS) {
      if (field in delta && delta[field] === '') delete delta[field];
    }
    if (Array.isArray(delta.recent_decisions)) {
      delta.recent_decisions = delta.recent_decisions.map((d) => {
        if (!d || typeof d !== 'object') return d;
        // The schema requires decided_at, so we still stamp `now` when the model
        // omits a date — but flag it date_inferred so selectRecentDecisions ranks
        // it BELOW genuinely-dated decisions instead of floating an undated claim
        // to the top of the brief as if it were the freshest.
        const at = normalizeModelDate(d.decided_at);
        return at
          ? { ...d, decided_at: at }
          : { ...d, decided_at: now, date_inferred: true };
      });
    }
    // Landmines: stamp/flag added_at like decisions, then apply the vagueness guard
    // (reusing isVagueDecision — same "concrete enough to be useful" test). The
    // WRITE_CONFIDENCE_FLOOR gate is applied separately in contextSyncService's
    // sanitizeExtraction; this drops noise the LLM emitted despite the prompt rule.
    if (Array.isArray(delta.landmines)) {
      const filtered = delta.landmines
        .filter((l) => l && typeof l === 'object' && String(l.summary || '').trim())
        .filter((l) => !isVagueDecision(l.summary))
        .map((l) => {
          const at = normalizeModelDate(l.added_at);
          return at
            ? { ...l, added_at: at }
            : { ...l, added_at: now, date_inferred: true };
        });
      if (filtered.length) delta.landmines = filtered;
      else delete delta.landmines;
    }
    // SHIPPED: completions the model read in the chunk arrive as bare strings in
    // `completed_work`. Never let the model author `shipped` directly (it would
    // self-certify as VERIFIED) — drop it, then rebuild from completed_work stamped
    // confidence 0.5 so these always render INFERRED. Only structured completion
    // events and board Done-transitions earn confidence 1. Reuse the vagueness guard.
    delete delta.shipped;
    if (Array.isArray(delta.completed_work)) {
      const shipped = delta.completed_work
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s && !isVagueDecision(s))
        .map((summary) => ({ summary, shipped_at: now, confidence: 0.5 }));
      if (shipped.length) delta.shipped = shipped;
    }
    delete delta.completed_work;
    // The board is moved by people and by structured events, never by a model
    // reading a conversation. These are merge DIRECTIVES, and remove_todos is a
    // hard delete: a paraphrase in an extraction must not be able to reach it.
    for (const directive of BOARD_DIRECTIVE_KEYS) delete delta[directive];
    out.delta = delta;
  }
  return out;
}

// The project's stored context, as THIS actor may read it. Lazy require: the
// service requires nothing from here, but the route layer loads both and a
// top-level require would make the load order matter.
async function loadExistingContext(actor, projectId) {
  if (!projectId) return null;
  try {
    const service = require('./contextSyncService');
    const project = await service.getProject(actor, projectId);
    return project?.context || null;
  } catch (err) {
    console.warn('[EXTRACTION] Could not load existing context:', err.message);
    return null;
  }
}

function rateGuardKey(scope, renderedChunks) {
  return `${scope}:${crypto.createHash('sha1').update(renderedChunks).digest('hex')}`;
}

// `input.explicit` marks a caller who ASKED for this text to be saved
// (update_context), as opposed to a passive capture of a conversation.
async function runExtraction(actor, input) {
  const projectId = input.project_id
    ? `proj:${input.project_id}`
    : input.session_id
      ? `sess:${input.session_id}`
      : 'unknown';
  const now = Date.now();
  const chunks = chunksFromInput(input);
  const renderedChunks = renderChunks(chunks);
  // KEYED BY CONTENT, NOT BY PROJECT.
  //
  // The guard exists to stop the same chunk being extracted twice in a burst.
  // Keyed on the project alone it answered a DIFFERENT summary, or a teammate's
  // write to the same project, with the previous call's delta: the second
  // caller's words were dropped and the first caller's were reported back as
  // theirs. Per-actor as well, because a cached result carries routing that was
  // resolved against one person's visible projects.
  const guardKey = rateGuardKey(`${getActorKey(actor)}:${workspace.actorPersonId(actor) || ''}:${projectId}`, renderedChunks);
  const guard = rateGuard.get(guardKey);

  if (guard && now - guard.lastAt < RATE_GUARD_MS) {
    console.log(`[EXTRACTION] Rate guard active for project ${projectId}, returning cached response`);
    return guard.cachedResponse;
  }

  // An explicit save is not gated on looking substantial. "Use pnpm" is eight
  // characters and a complete decision; the caller asked for it to be stored.
  if (!input.explicit && isTrivialConversation(chunks)) {
    // Never cached: a verdict about THIS text says nothing about the next one,
    // and a cached `ignored` made the following real update inherit it.
    return {
      match_decision: 'ignored',
      confidence: 0,
      delta: {},
      should_create_project: false,
      needs_user_confirmation: false,
      no_material_change: true,
      routing_state: 'global_only',
      suppression_reason: 'trivial_conversation',
    };
  }

  // A caller that names the project has settled routing. Running the heuristic
  // anyway let a strong overlap with some OTHER project answer 'stale_binding',
  // which is terminal, so an explicit write to a named project was dropped.
  const heuristicMatch = input.explicit && input.project_id
    ? await buildExplicitRouting(actor, input.project_id)
    : await resolveHeuristicMatch(actor, input, chunks);
  console.log('[EXTRACTION] Heuristic routing', JSON.stringify({
    projectId,
    sessionId: input.session_id || null,
    candidate: heuristicMatch?.project_candidate?.project_id || null,
    decision: heuristicMatch?.match_decision || 'none',
    routingState: heuristicMatch?.routing_state || null,
  }));
  // An ambiguous or stale-binding result IS terminal: without a settled project
  // there is nowhere for a delta to go, and guessing is the failure the stale
  // check exists to prevent. A 'matched_existing' result is NOT terminal — it
  // has decided routing and said nothing about content, so extraction runs.
  // Not cached, for the same reason as the trivial verdict above.
  if (heuristicMatch && !isRoutingOnly(heuristicMatch)) {
    return heuristicMatch;
  }

  // Every failure path below falls back to the ROUTED result when we have one
  // rather than to SAFE_FALLBACK. Both store nothing, but the routed one keeps
  // the project we already resolved, so a provider blip degrades to "matched,
  // nothing extracted" instead of throwing the session back to 'ambiguous' and
  // asking the user to re-confirm a binding that was never in doubt.
  const fallback = heuristicMatch || SAFE_FALLBACK;

  const credential = extractorCredential();
  if (!credential.ok) {
    console.warn(`[EXTRACTION] ${credential.missing} not set, returning safe fallback`);
    return fallback;
  }

  // THE MODEL HAS TO SEE WHAT IS ALREADY STORED.
  //
  // Neither caller ever supplied input.context: the hosted handler does not
  // build one and the REST schema strips it. So the digest below always read
  // "(no existing context — this may be a new project)", the model treated
  // every chunk as the first word on a new project, and it invented a
  // current_task from a status line and wrote it over the one a person set.
  const existingContext = input.context
    || heuristicMatch?.existingContext
    || await loadExistingContext(actor, input.project_id || heuristicMatch?.project_candidate?.project_id);
  const contextSummary = buildContextDigest(existingContext);
  const todayDate = new Date().toISOString().slice(0, 10);
  const userMessage = `Today's date: ${todayDate}\n\nExisting project context digest:\n${contextSummary}\n\nNew conversation chunk from ${input.tool}:\n${renderedChunks}`;
  const approximatePromptTokens = approximateTokens(`${SYSTEM_PROMPT}\n${userMessage}`);

  // A caller's explicit budget (the hosted MCP path) wins; then LLM_TIMEOUT_MS;
  // then the provider default.
  const timeoutMs = Number(input.timeout_ms) > 0
    ? Number(input.timeout_ms)
    : (IS_ANTHROPIC ? EXTRACTION_TIMEOUT_MS : resolveTimeout(credential.config, EXTRACTION_TIMEOUT_MS));

  let rawResponse;
  try {
    if (IS_ANTHROPIC) {
      const requestBody = {
        model: PROVIDER_CONFIG.model,
        max_tokens: 640,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      };
      const headers = {
        'x-api-key': credential.key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'Content-Type': 'application/json',
      };
      const response = await axios.post(PROVIDER_CONFIG.url, requestBody, { headers, timeout: timeoutMs });
      const cacheHit = response.data?.usage?.cache_read_input_tokens;
      if (cacheHit > 0) console.debug(`[EXTRACTION] Cache hit: saved ${cacheHit} tokens`);
      rawResponse = response.data?.content?.[0]?.text;
    } else {
      rawResponse = await chatCompletion(axios, buildOpenAiRequest(credential.config, userMessage), {
        timeoutMs,
        config: credential.config,
      });
    }
  } catch (err) {
    console.warn(`[EXTRACTION] ${PROVIDER} API call failed:`, err.message);
    return fallback;
  }

  if (!rawResponse) {
    console.warn('[EXTRACTION] Empty response from LLM');
    return fallback;
  }

  let parsed;
  try {
    parsed = parseJsonLoose(rawResponse);
  } catch (_) {
    console.warn('[EXTRACTION] Failed to parse LLM response as JSON');
    return fallback;
  }

  const validated = ExtractionResponseSchema.safeParse(sanitizeTaskProgress(sanitizeLlmOutput(parsed)));
  if (!validated.success) {
    console.warn('[EXTRACTION] LLM response failed schema validation:', validated.error.issues);
    return fallback;
  }

  // Routing from the heuristic (when it had one), content from the model.
  const result = applyHeuristicRouting(validated.data, heuristicMatch);

  console.log(`[EXTRACTION] Project ${projectId}: match=${result.match_decision} confidence=${result.confidence}`);
  console.log('[EXTRACTION] Metrics', JSON.stringify({
    projectId,
    chunkCount: chunks.length,
    characterCount: renderedChunks.length,
    approximatePromptTokens,
    approximateOutputTokens: approximateTokens(rawResponse),
    noMaterialChange: result.no_material_change,
    routedByHeuristic: isRoutingOnly(heuristicMatch),
  }));

  rateGuard.set(guardKey, { lastAt: now, cachedResponse: result });
  return result;
}

// The envelope for an import the model has processed: it forces creation of
// the named project, with the delta the model returned, and never reports
// no_material_change/ignored (match_decision and no_material_change must never
// veto an explicit import).
function buildSeedExtraction(projectName, delta) {
  return {
    match_decision: 'new_project',
    confidence: 1,
    delta,
    should_create_project: true,
    needs_user_confirmation: false,
    no_material_change: false,
    project_candidate: {
      project_name: projectName,
      reason: 'seeded from import',
      score: 1.0,
    },
  };
}

// AN IMPORT NO MODEL HAS PROCESSED SAVES NOTHING FROM THE CONVERSATION.
//
// When no extractor was configured, or its call failed (no answer, unparseable,
// schema miss), the import used to copy the person's longest message, up to 280
// characters, into the brief's description and from there into a plaintext
// graph node, while three public pages say raw conversation text is never kept
// (journey scan round 3, BLOCKED 25). The owner's decision (round 4): nothing
// from the conversation is saved, and the person is told it could not be
// processed and to try again.
//
// What is kept is what carries no conversation text: the project, under the
// name the person gave, with an empty brief. `not_processed` tells the /seed
// route to create only that and to report the project as not processed, never
// as imported. A retry finds the project by name and fills it.
function buildSeedNotProcessed(projectName) {
  return {
    ...buildSeedExtraction(projectName, {}),
    confidence: 0,
    not_processed: true,
  };
}

// Seed extraction: like runExtraction but no rate guard and forces project creation.
// Used for one-time import of historical conversation data. Three answers: thin
// content is skipped (ignored); a model's answer is created
// (buildSeedExtraction); no model answer is not processed
// (buildSeedNotProcessed), and saves nothing from the conversation.
async function runExtractionForSeed(actor, projectName, chunks) {
  // Gate on real substance FIRST. Import is a first-impression surface, so a
  // project only lands when there's content worth syncing — genuinely thin
  // conversations are skipped honestly (reported as projects_skipped) rather
  // than creating an empty project. Everything past this point HAS substance,
  // so it must create even if the LLM flakes.
  const meaningful = chunks.filter((c) => c.role === 'user' && c.text.length >= 80);
  if (meaningful.length === 0) {
    return { ...SAFE_FALLBACK, match_decision: 'ignored', no_material_change: true };
  }

  const credential = extractorCredential();
  if (!credential.ok) {
    // Substantial content but no extractor configured: nothing from the
    // conversation is saved, and the import says so (buildSeedNotProcessed).
    console.warn(`[EXTRACTION] ${credential.missing} not set, import of ${projectName} not processed`);
    return buildSeedNotProcessed(projectName);
  }

  // Take the 5 most information-dense messages
  const selected = meaningful
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 5);

  const renderedChunks = renderChunks(selected);
  const contextSummary = `Project name hint: ${projectName}\n(no existing context — bootstrapping from history)`;
  const userMessage = `Existing project context digest:\n${contextSummary}\n\nHistorical conversation samples:\n${renderedChunks}`;

  const callSeedModel = async () => {
    if (IS_ANTHROPIC) {
      const requestBody = {
        model: PROVIDER_CONFIG.model,
        max_tokens: 640,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      };
      const headers = {
        'x-api-key': credential.key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'Content-Type': 'application/json',
      };
      const response = await axios.post(PROVIDER_CONFIG.url, requestBody, { headers, timeout: SEED_TIMEOUT_MS });
      return response.data?.content?.[0]?.text;
    }
    return chatCompletion(axios, buildOpenAiRequest(credential.config, userMessage), {
      timeoutMs: resolveTimeout(credential.config, SEED_TIMEOUT_MS),
      config: credential.config,
    });
  };

  // Retry once on transient failure — a single timeout/network blip must not
  // drop the user's import. A terminal failure saves nothing from the
  // conversation and reports the import as not processed.
  let rawResponse;
  for (let attempt = 0; attempt < 2 && !rawResponse; attempt++) {
    try {
      rawResponse = await callSeedModel();
    } catch (err) {
      console.warn(`[EXTRACTION] Seed API call failed (attempt ${attempt + 1}):`, err.message);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (!rawResponse) return buildSeedNotProcessed(projectName);

  let parsed;
  try {
    parsed = parseJsonLoose(rawResponse);
  } catch (_) {
    return buildSeedNotProcessed(projectName);
  }

  const validated = ExtractionResponseSchema.safeParse(sanitizeTaskProgress(sanitizeLlmOutput(parsed)));
  if (!validated.success) return buildSeedNotProcessed(projectName);

  // Force project creation for seed flow regardless of the model's classification
  // (match_decision / no_material_change must never veto an explicit import).
  // The schema defaults the delta's resolution lists, so a model that answered
  // with nothing still hands back a delta: it is created as it always was, and
  // holds only what the model wrote.
  return buildSeedExtraction(projectName, validated.data.delta);
}

module.exports = { runExtraction, runExtractionForSeed, sanitizeLlmOutput };
