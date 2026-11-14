'use strict';

const crypto = require('crypto');

// Single source of truth for masking secret material out of free-text before it is logged,
// persisted as shared context, or injected into another agent's prompt. Consumed by the
// logging layer (LOG-07), command capture (CSL-01), and the context persist path.
//
// Mask, don't drop: replace the secret span with [REDACTED] so surrounding context survives.

const REDACTED = '[REDACTED]';

// DeerDawn's OWN credentials. Every provider below had a pattern and ours did
// not, so a live key pasted into a summary was stored verbatim and served back by
// /active (which SessionStart injects into every new session), /inject, recall
// and the Trail export — and the Trail publish scanner, which uses this redactor
// as its floor, reported nothing. The shapes are exactly what the server mints:
//   API key / OAuth access token   dd_<8 hex>_<64 hex>   (utils/security.js generateApiKey)
//   OAuth refresh token            ddr_<64 hex>          (routes/oauth.js)
// `ddr?_` on the first form also takes a refresh-shaped key should that prefix
// ever be reused. Lowercase hex only, because that is all the minter emits. The
// non-secret display prefix on its own (`dd_<8 hex>`) is deliberately NOT
// matched: the dashboard shows it to identify a key and it grants nothing.
// The mcp-server client redactor (packages/mcp-server/src/redact.ts) carries the
// SAME two regexes; change them together.
const DEERDAWN_CREDENTIAL_PATTERNS = [
    /\bddr?_[0-9a-f]{8}_[0-9a-f]{64}\b/g,
    /\bddr_[0-9a-f]{64}\b/g,
];

// High-signal provider credential shapes. Ordered most-specific first.
//
// EVERY PREFIX IS ANCHORED ON ITS LEFT. These run at PERSIST time over every
// string in a project's context and over graph titles, so a prefix that may
// start mid-word is a pattern over ordinary text: `sk-` with no left boundary
// matched inside "task-", "ask-", "risk-", "disk-" and "flask-", and a
// canonical key is a title with its spaces folded to '-', so "Task queue retry
// worker" was stored as `service:ta[REDACTED]` — one key shared by every
// "Task …" service, which then merged on the unique index. The lookbehinds
// reject a preceding letter, digit or underscore. NOT a preceding '-': a
// canonical key folds a title's spaces to '-', so "Rotate sk-proj-…" becomes
// `rotate-sk-proj-…`, and that key must still read as carrying a secret
// (secretSafeKey below).
//
// And the shapes that can collide with an identifier also need a DIGIT inside
// the run (a real key is random base62 and carries one: 20 random characters
// without a digit is ~3% of keys at worst, and the OpenAI / Slack / Stripe
// keys actually issued are far longer). "sk-learn-pipeline-refactor-notes" is
// a kebab id; "sk-proj-…4f2" is a key.
// 64, not 256 (round 16): a prefix repeated end to end ("sk-sk-sk-…") is one
// candidate per three characters, each paying the whole window. 64 characters
// of a real key without a digit is (52/62)^64 ≈ 1e-5.
const DIGIT_WITHIN = (cls) => `(?=${cls}{0,64}[0-9])`;
const TOKEN_PATTERNS = [
    ...DEERDAWN_CREDENTIAL_PATTERNS,
    // Anthropic: the version tag (api03-, admin01-, oat01-) is specific enough
    // to need no left boundary, so a key glued to the text before it still goes.
    /sk-ant-[a-z]{2,12}[0-9]{2}-[A-Za-z0-9_-]{8,}/g,
    new RegExp(String.raw`(?<![A-Za-z0-9_])sk-${DIGIT_WITHIN('[A-Za-z0-9_-]')}[A-Za-z0-9_-]{20,}`, 'g'), // OpenAI sk- / sk-proj-
    new RegExp(String.raw`(?<![A-Za-z0-9])rk_(?:live|test)_${DIGIT_WITHIN('[A-Za-z0-9]')}[A-Za-z0-9]{8,}`, 'g'),        // Stripe restricted
    new RegExp(String.raw`(?<![A-Za-z0-9])(?:pk|sk)_(?:live|test)_${DIGIT_WITHIN('[A-Za-z0-9]')}[A-Za-z0-9]{8,}`, 'g'), // Stripe publishable/secret
    /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g,                                                  // AWS access key id
    /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,                                        // GitHub PAT/OAuth/app/refresh
    /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,                                      // GitHub fine-grained PAT
    new RegExp(String.raw`(?<![A-Za-z0-9])xox[baprs]-${DIGIT_WITHIN('[A-Za-z0-9-]')}[A-Za-z0-9-]{10,}`, 'g'), // Slack
    /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,                                             // Google API key
    // JWT. LEFT-ANCHORED (round 16): unanchored, "eyJeyJeyJ…" was one candidate
    // per three characters, each walking the whole run to fail on the missing
    // '.', which is quadratic — 20 KB of it took 260 ms in every redactor. A token
    // glued to a URL-encoded separator (`id_token%3DeyJ…`) still counts.
    new RegExp(String.raw`(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2}))eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`, 'g'),
    // Round 15: shapes the mcp-server client redactor already knew and this,
    // the persist floor, did not — plus two neither had. Each is a prefix no
    // ordinary word carries; the ones a kebab id could start with need a digit.
    /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,                                     // SendGrid
    /\bnpm_[A-Za-z0-9]{20,}/g,                                                           // npm automation/publish token
    new RegExp(String.raw`(?<![A-Za-z0-9])whsec_(?=[A-Za-z0-9+/=]{0,64}[0-9A-Z])[A-Za-z0-9+/=]{16,}`, 'g'), // Stripe/Svix webhook secret
    // GitLab PAT: mixed-case base62, so a digit AND a capital — a lowercase
    // kebab id ("glpat-rotation-runbook-v2") carries no capital.
    new RegExp(String.raw`(?<![A-Za-z0-9])glpat-${DIGIT_WITHIN('[A-Za-z0-9_.-]')}(?=[A-Za-z0-9_.-]{0,64}[A-Z])[A-Za-z0-9_.-]{20,}`, 'g'),
    /(?<![A-Za-z0-9])pypi-AgE[A-Za-z0-9_-]{40,}/g,                                        // PyPI API token (macaroon)
    // Slack incoming webhook: the path IS the credential. The host stays so the
    // text still says what it was.
    /(?<=hooks\.slack\.com\/(?:services|workflows|triggers)\/)T[A-Z0-9]{6,16}\/[AB][A-Z0-9]{6,16}\/[A-Za-z0-9]{16,64}/g,
    // Round 16: formats every redactor still let through. Fly.io is DeerDawn's
    // own deploy target — `fly tokens create` prints `FlyV1 fm2_…` (a space, and
    // several macaroons joined by commas); the bare fm1_/fm2_/fo1_ forms are what
    // lands in an env file. Hugging Face (mixed-case base62, so an `hf_` snake id
    // is not one), Shopify admin/app tokens (32 hex), Linear, and Doppler's
    // service / personal / CLI / service-account tokens.
    /\bFlyV1[ _][A-Za-z0-9_+/=,-]{16,}/g,
    /(?<![A-Za-z0-9])f(?:m1|m2|o1)_[A-Za-z0-9_+/=,-]{16,}/g,
    // A signed URL's signature IS the credential (Azure SAS `sig=`, S3 / GCS
    // presigned URLs). The URL and its other parameters stay readable.
    /(?<=[?&](?:sig|X-Amz-Signature|X-Goog-Signature)=)[A-Za-z0-9%+/=_-]{16,1024}/g,
    /(?<![A-Za-z0-9_])hf_(?=[A-Za-z0-9]{0,40}[A-Z])(?=[A-Za-z0-9]{0,40}[a-z])[A-Za-z0-9]{30,40}(?![A-Za-z0-9])/g,
    /(?<![A-Za-z0-9])shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}(?![A-Za-z0-9])/g,
    /(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{30,}/g,
    /(?<![A-Za-z0-9.])dp\.(?:pt|st|ct|sa|scim|audit)\.(?:[A-Za-z0-9_-]{1,64}\.)?[A-Za-z0-9]{40,}/g,
    // Round 17: formats in gitleaks' default rules that every redactor let
    // through bare. Each is anchored on its left and shape-specific; the one a
    // kebab id could start with (GitLab's other token kinds) needs a digit AND a
    // capital, as glpat- does. PARITY: all three redactors carry these lines.
    /(?<![A-Za-z0-9])NRAK-[A-Za-z0-9]{27}(?![A-Za-z0-9])/g, // New Relic user API key
    /(?<![A-Za-z0-9])NRII-[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g, // New Relic insert key
    /(?<![A-Za-z0-9])sntrys_eyJ[A-Za-z0-9+/=_-]{20,1024}/g, // Sentry org auth token
    /(?<![A-Za-z0-9])sntryu_[a-f0-9]{64}(?![A-Za-z0-9])/g, // Sentry user auth token
    /(?<![A-Za-z0-9_.])sk\.eyJ[A-Za-z0-9_-]{10,512}\.[A-Za-z0-9_-]{20,1024}/g, // Mapbox secret token (pk. is public)
    /(?<![A-Za-z0-9])ATATT3[A-Za-z0-9_=-]{150,1024}/g, // Atlassian API token
    /(?<![A-Za-z0-9])do[por]_v1_[a-f0-9]{64}(?![A-Za-z0-9])/g, // DigitalOcean PAT / OAuth / refresh
    /(?<![A-Za-z0-9])gl(?:dt|rt|ptt|cbt|ft|imt|soat)-(?=[A-Za-z0-9_.-]{0,64}[0-9])(?=[A-Za-z0-9_.-]{0,64}[A-Z])[A-Za-z0-9_.-]{20,1024}/g, // GitLab deploy / runner / trigger / ...
    /(?<![A-Za-z0-9.])hv[sbr]\.(?=[A-Za-z0-9_-]{0,64}[0-9])[A-Za-z0-9_-]{24,1024}/g, // HashiCorp Vault service / batch / recovery
    /(?<![A-Za-z0-9])dapi[a-f0-9]{32}(?:-[0-9])?(?![A-Za-z0-9])/g, // Databricks
    /(?<![A-Za-z0-9])glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?![A-Za-z0-9])/g, // Grafana service account
    /(?<![A-Za-z0-9])glc_(?=[A-Za-z0-9+/]{0,64}[0-9])[A-Za-z0-9+/]{32,400}={0,2}/g, // Grafana Cloud
    /AGE-SECRET-KEY-1[0-9A-Z]{58}/g, // age
    /(?<![A-Za-z0-9])pscale_(?:pw|tkn|oauth)_[A-Za-z0-9=._-]{32,64}/g, // PlanetScale
    /(?<![A-Za-z0-9])[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_=-]{60,1024}/g, // Terraform Cloud / Enterprise
];

// PEM / private-key blocks (RSA/EC/DSA/OPENSSH/PGP/PKCS8 and other private-key
// exports), paired BEGIN -> first END after it, exactly as the old lazy
// BEGIN[\s\S]*?END regex paired them. That regex was linear only when it
// found its END: every BEGIN with no END after it scanned to the end of the
// input and failed, so a paste holding many unterminated BEGINs was quadratic.
// Cutting the input at the end of the LAST END marker keeps every pairing
// identical (a block's first END is never after the last one) and leaves no
// BEGIN that can fail. Runs FIRST, so no later pass can break a fence first.
// The mcp-server redactor walks the fences by hand and also masks an
// UNTERMINATED key; this floor keeps its long-standing terminated-only rule.
const PEM_BLOCK = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
function redactPemBlocks(input) {
    if (!input.includes('-----BEGIN ')) return input;
    let lastEnd = -1;
    for (const m of input.matchAll(PEM_END)) lastEnd = m.index + m[0].length;
    if (lastEnd < 0) return input;
    return input.slice(0, lastEnd).replace(PEM_BLOCK, REDACTED) + input.slice(lastEnd);
}

// Every quantifier on an open-ended run below carries a ceiling. These passes
// run at PERSIST time over whatever a caller sends, and an unbounded run that
// fails and is retried from the next character is quadratic (round 16: a PATCH
// with a 40 KB description held the API for 15 seconds, most of it URI_CREDS).
// A credential needing more than MAX_SECRET characters is a PEM block or a JWT,
// and both have their own patterns.
const MAX_SECRET = 1024;

// Authorization headers / bearer tokens: redact the credential, keep the scheme.
// An optional closing quote (["']?) is allowed between the key name and the
// separator so JSON-quoted keys (e.g. {"api_key": "..."}) still redact — in
// JSON the closing quote sits between the key word-boundary and the `:`.
//
// THE SEPARATOR IS A ':' OR '=', OR WHITESPACE FOLLOWED BY A SCHEME. A bare
// whitespace separator with any 8-letter word as the value is a pattern over
// English: "Fix authorization middleware ordering" was stored as "Fix
// authorization [REDACTED] ordering", and every later lookup of that card by
// the title it was given missed. A header always has its colon; the one
// colon-less form worth catching is `Authorization Bearer <token>`.
//
// Values: after a named scheme, any 8+ run that is not a plain lowercase word
// ("Bearer authentication is required" is a sentence); quoted, a run with no
// whitespace; bare, a run carrying a digit, '+' or '=' — the same value guard
// ASSIGNMENT applies, so "authorization: required." is left alone.
const AUTH_VALUE_CHARS = '[A-Za-z0-9._\\-+/=~]';
const AUTH_HEADER = new RegExp(
    String.raw`\b(authorization|x-api-key|api[_-]?key)\b(["']?)(\s*[:=]\s*|\s+(?=(?:bearer|basic|token)\s))`
    + String.raw`(?:(["']?)((?:bearer|basic|token)\s+)(${AUTH_VALUE_CHARS}{8,${MAX_SECRET}})`
    + String.raw`|"${AUTH_VALUE_CHARS}{8,${MAX_SECRET}}"|'${AUTH_VALUE_CHARS}{8,${MAX_SECRET}}'`
    + String.raw`|(?=${AUTH_VALUE_CHARS}{0,256}[0-9+=])${AUTH_VALUE_CHARS}{8,${MAX_SECRET}})`,
    'gi',
);

// KEY=VALUE / KEY: VALUE where the key name signals a secret. Prefix before the
// KEY/TOKEN/SECRET/... suffix is 0-or-more (not 1-or-more) so a bare key name
// that IS one of the suffix words (e.g. "secret", "token") also matches, not
// just prefixed forms like OPENAI_API_KEY. Same optional-quote allowance as
// AUTH_HEADER above.
// Value guard: a secret value is at least 8 chars, contains no whitespace, and
// must contain a digit, '+' or '='. Without a guard the pattern matched ordinary
// prose — "ADMIN_PASSWORD: contact support" became "[REDACTED] support", and "the
// auth: middleware runs first" lost the word after the colon. The guard used to
// admit '-', '_', '.' and '/' as well, which is every kebab id, snake_case column
// and file path: "sort key: created_at", "token: short-lived", "key:
// src/auth/session.js" were all masked — at PERSIST time, irreversibly. Biased
// toward false negatives on purpose: silently mangling a user's debugging notes
// is worse than missing a low-entropy placeholder.
// Never re-reads a value an earlier pass already masked (`x-access-token:[REDACTED]@…`).
//
// A BARE "KEY" IS NOT A SECRET NAME. Database and UI text is full of keys that
// are not credentials — "Partition key: tenant_id", "primary key = (org_id,
// user_id)", "cache_key: user:123", "hotkey=ctrl+shift+k", "sort key" — and the
// old `[A-Za-z0-9_]*KEY` took every one of them. KEY counts only behind a word
// that makes it a credential (API_KEY, SECRET_KEY, PRIVATE_KEY, ACCESS_KEY,
// MASTER_KEY, SIGNING_KEY, ENCRYPTION_KEY, CLIENT_KEY, AUTH_KEY); a credential
// under any other *_KEY name is still caught when it has a provider's shape
// (TOKEN_PATTERNS). TOKEN, SECRET and PASSWORD keep their prefix-free form.
const SECRET_NAME = '(?:API|SECRET|PRIVATE|ACCESS|MASTER|SIGNING|ENCRYPTION|CLIENT|AUTH)[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH';
const ASSIGNMENT_GUARD = '(?=[^\\s\'";]{0,256}[0-9+=])';
// A value that is a REFERENCE to a secret is not one: `${API_KEY}`,
// `${{ secrets.GITHUB_TOKEN }}`, `$(gh auth token)`, `$DB_PASSWORD_2`. A real
// secret that starts with '$' starts with a digit or a symbol after it (bcrypt's
// `$2b$…`), so it is still taken.
// Only `${…}`, `$(…)` and a bare `$NAME` that ENDS the value (round 17):
// `DB_PASSWORD=$uperS3cret!` is a password that starts with '$'.
const NOT_A_REFERENCE = String.raw`(?!["']?\$(?:[{(]|[A-Za-z_][A-Za-z0-9_]{0,128}(?![^\s'"\x60;,)}\]&|])))`;
const ASSIGNMENT_VALUE = String.raw`("${ASSIGNMENT_GUARD}[^"\s]{8,${MAX_SECRET}}"|'${ASSIGNMENT_GUARD}[^'\s]{8,${MAX_SECRET}}'|${ASSIGNMENT_GUARD}[^\s'";]{8,${MAX_SECRET}})`;
const ASSIGNMENT = new RegExp(
    String.raw`\b([A-Za-z0-9_]{0,64}(?:${SECRET_NAME}))\b(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${NOT_A_REFERENCE}${ASSIGNMENT_VALUE}`,
    'gi',
);

// ...AND AN UPPER_SNAKE ENV VAR NAMED FOR A CREDENTIAL HOLDS ONE: Rails'
// *_KEY_BASE, *_PASS, *_PWD, *_CREDENTIALS, and the TOKEN / SECRET / PASSWORD
// suffixes in the `:` and JSON forms. Only in the one form prose never uses —
// an UPPER_SNAKE name, matched CASE-SENSITIVELY — with ASSIGNMENT's value guard.
// *_KEY is NOT in this list any more; see KEY_NAME_ASSIGNMENT below.
// PARITY: packages/shared-context (SC_ENV_KEY_ASSIGNMENT) and
// packages/mcp-server/src/redact.ts (ENV_KEY_ASSIGNMENT) carry the same pattern.
const ENV_SECRET_SUFFIX = '_(?:KEY_BASE|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?)';
const ENV_KEY_ASSIGNMENT = new RegExp(
    String.raw`(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{0,64}${ENV_SECRET_SUFFIX})(?![A-Za-z0-9_])(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${NOT_A_REFERENCE}${ASSIGNMENT_VALUE}`,
    'g',
);
// Terraform's per-host credential variable, `TF_TOKEN_app_terraform_io=…`:
// the host rides in the name, so no suffix rule sees it (round 17).
const TF_TOKEN_ASSIGNMENT = new RegExp(
    String.raw`(?<![A-Za-z0-9_])(TF_TOKEN_[A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_-])(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${NOT_A_REFERENCE}${ASSIGNMENT_VALUE}`,
    'g',
);

// ANY NAME ENDING IN "KEY" — BUT ONLY OVER A SECRET-SHAPED VALUE.
//
// Round 14 stopped reading a bare KEY as a secret name, because a database, a
// cache and a UI are full of keys that are not credentials. Round 15 took
// UPPER_SNAKE *_KEY back on ASSIGNMENT's value guard (a digit, '+' or '='), and
// that guard is no test of a key at all: `const SEEN_KEY =
// 'dd_post_sync_modal_seen_v1'`, ROUTING_KEY=orders.created.v1,
// S3_OBJECT_KEY=exports/2026-09-23.csv and IDEMPOTENCY_KEY: order-2026-09-23-001
// were masked at storage — irreversibly — and two board cards that differed
// only in such a value merged into one. Meanwhile every non-UPPER_SNAKE name
// stayed open: Azure's `AccountKey=<base64>;`, `Ocp-Apim-Subscription-Key:
// <hex>`, `{"storageKey": …}`, `algoliaAdminKey: '…'`, `license_key = "…"`.
//
// So the NAME test is loose (camelCase, snake, kebab, dotted; any case) and the
// VALUE decides: masked only when it carries a secret's prefix (`base64:`,
// `key-`, `SG.`) or a 16+ character run that reads as random (secretShapedValue
// below). A name that says the value is published (`publicKey`,
// `NEXT_PUBLIC_POSTHOG_KEY`, `publishableKey`) is never read as a secret.
const KEY_NAME_ASSIGNMENT = new RegExp(
    String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9][A-Za-z0-9_.-]{0,64}?key)(?![A-Za-z0-9_])(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${NOT_A_REFERENCE}${ASSIGNMENT_VALUE}`,
    'gi',
);
const PUBLIC_KEY_NAME = /public|publishable/i;
// Round 17: a name that says the key IDENTIFIES something — a cache entry, an
// object, an event, a row — holds a hash or an id, not a credential:
// `cacheKey=<sha1>` and `dedupeKey: evt_…` were masked, and two cards that
// differed only there merged. Credential-ish names (storageKey, accountKey,
// apiKey, secretKey, privateKey, accessKey, masterKey, signingKey,
// subscriptionKey, licenseKey, adminKey …) are deliberately NOT here.
// Round 18: the exempt word must be a WHOLE segment of the name (camelCase is
// split first), so `blockKey` is not `lock`+Key and `PROFILE_KEY` is not
// `file`+KEY; and words that also name real credentials were dropped —
// Azure `primaryKey`, Azure Cache `REDIS_KEY`, securecookie `hashKey`,
// PagerDuty `routing_key`, `EVENT_KEY`, `STATE_KEY`, `lockKey`.
const IDENTIFIER_KEY_NAME = /(?:^|[_.-])(?:cache|object|dedupe?|idempot(?:ency)?|sort|partition|shard|integrity|foreign|i18n|translation|etag|lookup|index|group(?:ing)?|row|range|composite|unique|cursor|react|item|path|message|record)[_.-]?key$/;
function isIdentifierKeyName(key) {
    const snake = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    return IDENTIFIER_KEY_NAME.test(snake);
}
// A value that NAMES its digest algorithm is a digest (`integrity:
// sha512-…`, an ssh host key's `SHA256:…` fingerprint), never a secret.
const DIGEST_VALUE = /^(?:sha(?:1|224|256|384|512)|md5|blake2[bs]?|xxh(?:32|64|128|3)?)[-:]/i;
const SECRET_VALUE_PREFIX = /^(?:base64:|key-|SG\.)/;

// Does a run read as random? Split on the separators identifiers, paths and
// keys are made of ([-_.:/]), then look for ONE piece of 16+ characters that
// changes character class (lower / upper / digit / other) far more often than
// words do. Random base62 changes class on ~60% of characters; a camelCase word
// changes twice per hump. Hex and base32 (one letter case plus digits) change
// less, so they need two of each and a change every four characters.
// PARITY: shared-context scSecretShapedValue and mcp-server secretShapedValue.
function secretShapedRun(run) {
    if (run.length < 16) return false;
    let digits = 0, upper = 0, lower = 0, changes = 0, prev = '';
    for (const ch of run) {
        const cls = ch >= '0' && ch <= '9' ? 'd' : ch >= 'A' && ch <= 'Z' ? 'u' : ch >= 'a' && ch <= 'z' ? 'l' : 'o';
        if (cls === 'd') digits++; else if (cls === 'u') upper++; else if (cls === 'l') lower++;
        if (prev && cls !== prev) changes++;
        prev = cls;
    }
    if (!digits || upper + lower < 2) return false;
    if (upper && lower) return changes * 3 >= run.length || (changes + 1) * 2 >= run.length;
    if (digits < 2) return false;
    if (/^(?:[0-9a-f]+|[0-9A-F]+)$/.test(run)) return true; // hex
    return changes * 5 >= run.length;
}
function secretShapedValue(value) {
    const v = String(value).replace(/^["']|["']$/g, '');
    if (DIGEST_VALUE.test(v)) return false;
    if (SECRET_VALUE_PREFIX.test(v)) return true;
    // '/' separates a path's segments but is also a base64 character: a piece
    // carrying '+' or '=' is read whole, anything else is split on '/' too.
    return v.split(/[-_.:]+/).some((piece) => (/[+=]/.test(piece) ? secretShapedRun(piece) : piece.split('/').some(secretShapedRun)));
}

// `x-api-key <token>` — the header as curl -v and most HTTP logs print it, with
// no colon. Only when the value is secret-SHAPED (16+ characters holding both a
// letter and a digit), because "x-api-key header" and "x-api-key rotation" are
// how people talk about it. The colon / '=' / scheme forms are AUTH_HEADER's.
const X_API_KEY_SPACE = new RegExp(
    String.raw`\b(x-api-key)(["']?[ \t]{1,16}["']?)(?=${AUTH_VALUE_CHARS}{0,256}[0-9])(?=${AUTH_VALUE_CHARS}{0,256}[A-Za-z])${AUTH_VALUE_CHARS}{16,${MAX_SECRET}}`,
    'gi',
);

// Credentials embedded in a connection URI: scheme://user:PASSWORD@host
// The user part may be EMPTY: `redis://:password@host` is Redis's normal shape
// (it has no username), and a required user character let the password through.
//
// BOUNDED (round 16). The scheme was `[a-z0-9+.-]*` and the user part `*`: on a
// long run of letters every start position walked the whole run looking for
// `://` and failed, so 40 KB of description held the API for 15 seconds and
// every later read of that project paid again. A scheme is at most 32
// characters (RFC 3986 keeps them far shorter) and userinfo past 256 is not a
// credential anyone typed — shared-context has carried these ceilings since it
// measured 22 s on 200 KB.
//
// And the password runs to the LAST '@' before the host, as a URL parser reads
// userinfo: `postgres://u:p@ss@host` masked only `p`. It stops at '/', a quote,
// a backtick, an angle bracket or a backslash, so compact JSON
// (`"a":"http://h:80","b":"x@y.io"`) is not read as one long password.
// PARITY: SC_URI_CREDS in packages/shared-context, URI_CREDS in mcp-server.
const URI_SCHEME_MAX = 31;
const URI_PART_MAX = 256;
const URI_CREDS = new RegExp(
    String.raw`([a-z][a-z0-9+.-]{0,${URI_SCHEME_MAX}}://[^\s:/@]{0,${URI_PART_MAX}}:)((?:(?!,[a-z][a-z0-9+.-]{0,31}:)[^\s/"'\x60<>\\?#]){1,${URI_PART_MAX}})(@)`,
    'gi',
);

/**
 * Redact secret material from a string. Non-strings are returned unchanged.
 * @param {string} input
 * @returns {string}
 */
function redactSecrets(input) {
    if (typeof input !== 'string' || input.length === 0) return input;
    let out = redactPemBlocks(input);
    out = out.replace(URI_CREDS, `$1${REDACTED}$3`);
    out = out.replace(AUTH_HEADER, (m, key, quote, sep, openQuote, scheme, schemeValue) => {
        // "Authorization: Bearer authentication is required" — a plain lowercase
        // word after a scheme name is a sentence, not a token.
        if (scheme && /^[a-z]+$/.test(schemeValue)) return m;
        return `${key}${quote}${sep}${openQuote || ''}${scheme || ''}${REDACTED}`;
    });
    out = out.replace(X_API_KEY_SPACE, (m, key, sep) => `${key}${sep}${REDACTED}`);
    out = out.replace(ASSIGNMENT, (m, key, quote, sep) => `${key}${quote}${sep}${REDACTED}`);
    out = out.replace(ENV_KEY_ASSIGNMENT, (m, key, quote, sep) => `${key}${quote}${sep}${REDACTED}`);
    out = out.replace(TF_TOKEN_ASSIGNMENT, (m, key, quote, sep) => `${key}${quote}${sep}${REDACTED}`);
    out = out.replace(KEY_NAME_ASSIGNMENT, (m, key, quote, sep, value) => (
        PUBLIC_KEY_NAME.test(key) || isIdentifierKeyName(key) || !secretShapedValue(value) ? m : `${key}${quote}${sep}${REDACTED}`));
    for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
    return out;
}

/**
 * Recursively redact string values in an object/array (depth-bounded). Keys are preserved.
 * @param {*} value
 * @param {number} depth
 */
function redactDeep(value, depth = 0) {
    if (depth > 6) return value;
    if (typeof value === 'string') return redactSecrets(value);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
        return out;
    }
    return value;
}

/**
 * An IDENTITY that is safe to store: a graph canonical key, returned unchanged
 * unless it (or the text it was derived from, `source`) carries a secret.
 *
 * A key is not text to be masked in place. It is the row's identity under
 * UNIQUE (owner_key, node_type, canonical_key), so masking it to a shared
 * "[REDACTED]" token makes every key that differed only in the secret one key:
 * distinct entities merge on ON CONFLICT (the second's title over the first's
 * summary, across projects), and a relation that names either one by the key
 * its caller built finds nothing. So a secret-bearing key becomes a stable,
 * non-reversible stand-in: the type prefix it had (a lookup splits on it) and a
 * SHA-256 of the whole raw key. Distinct keys stay distinct, the same key maps to
 * the same row every time, and a lookup that runs the same function finds it.
 * @param {string} key
 * @param {{ source?: string }} [options]
 * @returns {string}
 */
function secretSafeKey(key, { source } = {}) {
    if (typeof key !== 'string' || key.length === 0) return key;
    const carriesSecret = redactSecrets(key) !== key
        || (typeof source === 'string' && source.length > 0 && redactSecrets(source) !== source);
    if (!carriesSecret) return key;
    const colon = key.indexOf(':');
    const type = colon > 0 ? key.slice(0, colon) : '';
    const prefix = /^[a-z_]{1,40}$/.test(type) ? `${type}:` : '';
    return `${prefix}redacted-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

module.exports = { redactSecrets, redactDeep, secretSafeKey, REDACTED, DEERDAWN_CREDENTIAL_PATTERNS };
