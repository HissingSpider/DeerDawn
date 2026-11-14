// ─── Public repo -> brief source ────────────────────────────────────────────
//
// Level-0 surface: someone pastes a public GitHub URL and gets the four brief
// slots back, with no account and nothing installed. This module does the
// GitHub half — fetch the few files and signals a repo can honestly yield —
// and hands a plain-text digest to the caller, which runs the same LLM
// extraction the /ai-context-brief endpoint already uses.
//
// WHAT A REPO CAN AND CANNOT TELL YOU. A repo says what a project *is*. It does
// not say where you left off, which is the thing DeerDawn actually sells. The
// honest mapping is:
//   README + repo metadata -> description, tech_stack
//   CLAUDE.md / AGENTS.md  -> decisions, conventions, landmines
//   recent commit subjects -> current_task, current_status  (a proxy, and the
//                             digest labels it as one so the model does not
//                             present it as stated fact)
//   open issues            -> open_questions
// Anything beyond that would be invention, and the extraction prompt is written
// to refuse it.
//
// SSRF: the pasted URL is parsed into owner/repo and never fetched directly —
// every request goes to api.github.com through safeGet, which keeps the
// private-range / DNS-rebind defence. Same posture as the skill importer.

const { safeGet } = require('../utils/safeHttp');

// Both heavy dependencies are required lazily rather than at module load.
// Importing either one opens a Redis connection and leaves reconnect timers on
// the event loop (verified: requiring contextSyncService alone leaves two live
// Timeouts), so a unit test that only exercises the pure digest and filter
// helpers would never exit — it would hang until the runner killed it, which
// reads as a broken test rather than a module that holds a socket.
//
// Production behaviour is unchanged: the app already holds the same shared
// Redis client, and the first real request resolves both requires anyway.
let redisClient = null;
function getRedis() {
  if (!redisClient) redisClient = require('../config/redis').redis;
  return redisClient;
}

function parseGithubTarget(input) {
  return require('./contextSyncService').parseGithubSkillTarget(input);
}

const GITHUB_API = 'https://api.github.com';

// Files worth reading, in the order they earn their place in the digest. Probed
// against the root listing rather than fetched blind, so a repo without them
// costs no extra API calls.
const CONTEXT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  'README.md',
  'readme.md',
  'CONTRIBUTING.md',
];

// Only the first two matched files are read. Three README-sized files would
// dominate the extraction input and push the signal from CLAUDE.md out of it.
const MAX_FILES_READ = 2;
const MAX_FILE_CHARS = 6000;
const MAX_COMMITS = 20;
const MAX_ISSUES = 10;

// A repo's answer changes about as often as it is pushed to. Six hours keeps a
// popular repo effectively free while a busy one stays current, and it is the
// difference between 60 GitHub calls an hour serving ~12 briefs and serving
// hundreds. Cache holds the DIGEST, not the LLM output, so a prompt change
// takes effect without a flush.
const CACHE_TTL_SECONDS = 6 * 60 * 60;

let warnedNoGithubToken = false;

function repoBriefError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function githubHeaders() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'DeerDawn-RepoBrief' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (!warnedNoGithubToken) {
    warnedNoGithubToken = true;
    console.warn(
      '[REPO-BRIEF] GITHUB_TOKEN unset — GitHub calls are capped at 60/hour for the whole server IP, ' +
      'which is roughly 12 repo briefs an hour across all visitors. Set GITHUB_TOKEN to raise it to 5,000/hour.'
    );
  }
  return headers;
}

// One GitHub GET. Returns null on 404 so callers can treat "no such file" as a
// normal outcome rather than an error.
//
// REDIRECTS: a renamed or transferred repository answers 301, and safeGet does
// not follow redirects by design — that is the SSRF defence. Refusing outright
// was wrong though: it fails on a large share of exactly the well-known repos
// someone pastes to try the tool (facebook/react is a 301 today). So we follow
// at most ONE hop, and only when the target is still api.github.com, which
// keeps the guarantee that this module never fetches an attacker-chosen host.
async function ghGet(path, { allowRedirect = true } = {}) {
  let res;
  try {
    res = await safeGet(`${GITHUB_API}${path}`, {
      headers: githubHeaders(),
      responseType: 'json',
      validateStatus: (s) => s === 200 || s === 404 || s === 301,
    });
  } catch (err) {
    const status = err?.response?.status;
    // GitHub signals an exhausted quota as 403 on the classic path and 429 on
    // the newer one; both need "wait a minute", not "your URL is wrong".
    if (status === 403 || status === 429) throw repoBriefError('github_rate_limited', 429);
    if (status === 451) throw repoBriefError('github_repo_unavailable', 451);
    throw repoBriefError('github_fetch_failed', 502);
  }

  if (res.status === 301) {
    if (!allowRedirect) throw repoBriefError('github_fetch_failed', 502);
    const target = res.headers?.location || res.data?.url;
    if (!target) throw repoBriefError('github_fetch_failed', 502);
    let next;
    try { next = new URL(target, GITHUB_API); } catch { throw repoBriefError('github_fetch_failed', 502); }
    if (next.origin !== GITHUB_API) throw repoBriefError('github_fetch_failed', 502);
    return ghGet(`${next.pathname}${next.search}`, { allowRedirect: false });
  }

  return res.status === 404 ? null : res.data;
}

function decodeContentFile(data) {
  // Files over 1 MB come back with encoding 'none' and an empty body.
  if (!data || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') return null;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

// Strip the parts of a README that carry no project signal — badge rows, HTML
// blocks, and fenced code — so the extraction input is prose about the project
// rather than shields.io URLs.
function condenseMarkdown(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_FILE_CHARS);
}

// Merge commits carry no intent ("Merge pull request #12 from …"), and a run of
// them would read to the model as the current task.
function isUsefulCommitSubject(subject) {
  if (!subject) return false;
  if (/^merge (pull request|branch|remote)/i.test(subject)) return false;
  if (/^(bump|chore\(deps\)|update dependencies)/i.test(subject)) return false;
  return subject.length > 3;
}

async function fetchRepoSource(owner, repo, ref) {
  const meta = await ghGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  if (!meta) throw repoBriefError('repo_not_found', 404);

  // Re-derive the path from the CANONICAL name the metadata came back with. On
  // a renamed repo the pasted owner/repo still resolves, but every subsequent
  // call would spend an extra redirect hop on it — and the label shown to the
  // visitor should be where the repo actually lives now, not where they
  // thought it was.
  if (typeof meta.full_name === 'string' && meta.full_name.includes('/')) {
    const [canonicalOwner, canonicalRepo] = meta.full_name.split('/');
    if (canonicalOwner && canonicalRepo) {
      owner = canonicalOwner;
      repo = canonicalRepo;
    }
  }
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const branch = ref || meta.default_branch || '';
  const refQuery = branch ? `?ref=${encodeURIComponent(branch)}` : '';

  // One listing of the repo root tells us which context files exist, so the
  // per-file fetches below are never speculative.
  const rootListing = await ghGet(`${base}/contents${refQuery}`);
  const present = new Set(
    Array.isArray(rootListing)
      ? rootListing.filter((e) => e && e.type === 'file').map((e) => e.name)
      : []
  );

  const wanted = CONTEXT_FILES.filter((name) => present.has(name)).slice(0, MAX_FILES_READ);
  const files = [];
  for (const name of wanted) {
    const data = await ghGet(`${base}/contents/${encodeURIComponent(name)}${refQuery}`);
    const markdown = decodeContentFile(data);
    if (markdown) files.push({ path: name, text: condenseMarkdown(markdown) });
  }

  // Commits and issues are independent of each other; a failure on either
  // should degrade the brief rather than fail the request.
  const [commitsRaw, issuesRaw] = await Promise.all([
    ghGet(`${base}/commits?per_page=${MAX_COMMITS}${branch ? `&sha=${encodeURIComponent(branch)}` : ''}`).catch(() => null),
    ghGet(`${base}/issues?state=open&per_page=${MAX_ISSUES}&sort=updated`).catch(() => null),
  ]);

  const commits = (Array.isArray(commitsRaw) ? commitsRaw : [])
    .map((c) => String(c?.commit?.message || '').split('\n')[0].trim())
    .filter(isUsefulCommitSubject)
    .slice(0, MAX_COMMITS);

  // GitHub returns pull requests from the issues endpoint; a PR title is not an
  // open question about the project.
  const issues = (Array.isArray(issuesRaw) ? issuesRaw : [])
    .filter((i) => i && !i.pull_request)
    .map((i) => String(i.title || '').trim())
    .filter(Boolean)
    .slice(0, MAX_ISSUES);

  return {
    owner,
    repo,
    ref: branch,
    meta: {
      description: meta.description || '',
      language: meta.language || '',
      topics: Array.isArray(meta.topics) ? meta.topics.slice(0, 10) : [],
      pushed_at: meta.pushed_at || '',
      stars: typeof meta.stargazers_count === 'number' ? meta.stargazers_count : 0,
      archived: Boolean(meta.archived),
    },
    files,
    commits,
    issues,
  };
}

// The plain-text digest handed to the extractor. Section headers do real work
// here: they tell the model which lines are stated fact (the files) and which
// are inference material (the commits), which is what keeps "current task" from
// being presented as something the project declared about itself.
function composeRepoDigest(source) {
  const parts = [];
  parts.push(`Project: ${source.owner}/${source.repo}`);
  if (source.meta.description) parts.push(`Repository description: ${source.meta.description}`);
  if (source.meta.language) parts.push(`Primary language: ${source.meta.language}`);
  if (source.meta.topics.length) parts.push(`Topics: ${source.meta.topics.join(', ')}`);
  if (source.meta.archived) parts.push('NOTE: this repository is archived.');

  for (const file of source.files) {
    parts.push(`\n--- STATED IN ${file.path} ---\n${file.text}`);
  }

  if (source.commits.length) {
    parts.push(
      '\n--- RECENT COMMIT SUBJECTS (most recent first; these are evidence of what is being worked on, not statements about the project) ---\n' +
      source.commits.map((c) => `- ${c}`).join('\n')
    );
  }

  if (source.issues.length) {
    parts.push(
      '\n--- OPEN ISSUE TITLES ---\n' + source.issues.map((i) => `- ${i}`).join('\n')
    );
  }

  return parts.join('\n');
}

/**
 * Turn a pasted GitHub URL into the text digest the brief extractor reads.
 * Accepts every URL shape the skill importer accepts (https, /tree/, /blob/,
 * git@, and bare owner/repo).
 *
 * Returns { digest, source } where source carries the provenance the UI shows
 * so a visitor can see which files the brief was actually built from.
 */
async function buildRepoDigest(repoUrl) {
  const target = parseGithubTarget(repoUrl); // throws github_url_* on bad input
  const { owner, repo, ref } = target;

  const cacheKey = `repo-brief:v1:${owner.toLowerCase()}/${repo.toLowerCase()}:${(ref || 'default').toLowerCase()}`;
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return { ...parsed, cached: true };
    }
  } catch {
    // A cache miss and a cache outage are the same thing to the caller.
  }

  const source = await fetchRepoSource(owner, repo, ref);

  // A repo with no README, no context file and no commit history has nothing to
  // extract from, and an empty brief reads as a broken product rather than an
  // empty repo. Say which it is.
  if (!source.files.length && !source.commits.length && !source.meta.description) {
    throw repoBriefError('repo_has_no_context', 422);
  }

  const payload = { digest: composeRepoDigest(source), source };
  try {
    await getRedis().set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
  } catch {
    // Caching is an optimisation; never fail the request over it.
  }
  return { ...payload, cached: false };
}

module.exports = {
  buildRepoDigest,
  // exported for tests
  composeRepoDigest,
  condenseMarkdown,
  isUsefulCommitSubject,
};
