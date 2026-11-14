// CSL-01 (client mirror of apps/api/src/utils/secretRedaction.js). Masks secret material out of
// captured shell commands BEFORE they leave the machine. Mask, don't drop.
//
// Every quantifier in this file is either a single character class or carries an
// explicit ceiling. These patterns run on whole transcripts and on a pasted
// CLAUDE.md, and an open-ended run that fails and retries from the next character
// is quadratic: packages/shared-context measured 22 seconds on 200 KB from the
// URI scheme matcher alone. A new pattern has to keep that property — see
// tests/redaction-gaps.test.ts, which times them instead of reading them.

const REDACTED = '[REDACTED]';

// Longest secret matched after a key name or a flag. Anything longer is a PEM
// block or a JWT, and both have their own patterns below.
const MAX_SECRET = 1024;
const LOOKAHEAD_WINDOW = 256;
// A provider prefix's digit/capital lookahead. 64, not 256 (round 16): a prefix
// repeated end to end ("sk-sk-sk-…") is one candidate per three characters,
// each paying the whole window. PARITY with DIGIT_WITHIN in the API redactor.
const PREFIX_WINDOW = 64;
const URI_SCHEME_MAX = 31;
const URI_PART_MAX = 256;
// How far back from a credential flag its program name may sit. Bounded so one
// `curl` costs a constant, however long the line it opens.
const COMMAND_WINDOW = 1000;

// ─── PEM / private-key blocks ────────────────────────────────────────────────
// RSA/EC/DSA/OPENSSH/PGP/PKCS8 and other private-key exports.
//
// This was one lazy regex, BEGIN[\s\S]*?END, run LAST. Three things were wrong
// with that, and a regex could fix only one of them:
//   - A BEGIN with no END never matched at all. Every capture path clips (a
//     command at 240 characters, a transcript message at its cap, a hook payload
//     wherever the host cut it), so a clipped key went out whole.
//   - It ran after the assignment pass, and `private_key: -----BEGIN ...` is the
//     commonest way a key appears. The assignment pass masked the ten characters
//     of "-----BEGIN", which destroyed the fence this pattern needed, and the
//     body followed it out untouched.
//   - Each BEGIN with no END scanned to the end of the input before failing, so
//     a document with many of them was quadratic.
// Walking the fences by hand fixes all three: two linear scans collect them, and
// one pass pairs each BEGIN with the END that follows it.
//
// An unterminated BEGIN takes the key-shaped run after it — base64, whitespace,
// the literal `\n` of a JSON-escaped key, the `Proc-Type: 4,ENCRYPTED` header
// punctuation — which for a truncated key IS the rest of the input. It does not
// take "everything to the end": a CLAUDE.md that merely mentions the BEGIN marker
// in a sentence would lose every paragraph after it, and the run stops at the
// first full stop, bracket or backtick instead. A BEGIN followed by another
// BEGIN before any END is unterminated for the same reason.
const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_BODY_RUN = /[A-Za-z0-9+/=\s\\:,-]*/y;

function redactPemBlocks(input: string): string {
  if (!input.includes('-----BEGIN ')) return input;
  const begins: Array<{ start: number; end: number }> = [];
  const ends: Array<{ start: number; end: number }> = [];
  for (const m of input.matchAll(PEM_BEGIN)) begins.push({ start: m.index, end: m.index + m[0].length });
  if (!begins.length) return input;
  for (const m of input.matchAll(PEM_END)) ends.push({ start: m.index, end: m.index + m[0].length });

  let out = '';
  let cursor = 0;
  let e = 0;
  for (let b = 0; b < begins.length; b++) {
    const begin = begins[b];
    if (begin.start < cursor) continue; // already inside a masked block
    while (e < ends.length && ends[e].start < begin.end) e++;
    const nextBegin = begins[b + 1]?.start ?? Infinity;
    let stop: number;
    if (e < ends.length && ends[e].start < nextBegin) {
      stop = ends[e].end;
    } else {
      PEM_BODY_RUN.lastIndex = begin.end;
      PEM_BODY_RUN.exec(input);
      stop = Math.max(PEM_BODY_RUN.lastIndex, begin.end);
    }
    out += input.slice(cursor, begin.start) + REDACTED;
    cursor = stop;
  }
  return out + input.slice(cursor);
}

const TOKEN_PATTERNS: RegExp[] = [
  // DeerDawn's own credentials, which were the one kind this file did not know.
  // Minted in apps/api: an API key (and an OAuth access token, which is minted
  // the same way) is `dd_<8 hex>_<64 hex>` (utils/security.js generateApiKey);
  // an OAuth refresh token is `ddr_<64 hex>` (routes/oauth.js). With the Stop
  // hook flushing typed prompts, a key pasted into a prompt went to the API
  // verbatim. PARITY: the API's secretRedaction.js carries the same two.
  /\bddr?_[0-9a-f]{8}_[0-9a-f]{64}\b/g,
  /\bddr_[0-9a-f]{64}\b/g,
  // Every prefix is anchored on its left, and the identifier-shaped ones need a
  // digit in the run. `sk-` with no left boundary matched inside "task-",
  // "risk-", "flask-", so a summary naming `task-scheduler-service-worker` left
  // this machine as `ta[REDACTED]`. PARITY: apps/api/src/utils/secretRedaction.js.
  // Anthropic: the version tag (api03-, admin01-, oat01-) is specific enough
  // to need no left boundary, so a key glued to the text before it still goes.
  /sk-ant-[a-z]{2,12}[0-9]{2}-[A-Za-z0-9_-]{8,}/g,
  new RegExp(String.raw`(?<![A-Za-z0-9_])sk-(?=[A-Za-z0-9_-]{0,${PREFIX_WINDOW}}[0-9])[A-Za-z0-9_-]{20,}`, 'g'),
  new RegExp(String.raw`(?<![A-Za-z0-9])rk_(?:live|test)_(?=[A-Za-z0-9]{0,${PREFIX_WINDOW}}[0-9])[A-Za-z0-9]{8,}`, 'g'),
  new RegExp(String.raw`(?<![A-Za-z0-9])(?:pk|sk)_(?:live|test)_(?=[A-Za-z0-9]{0,${PREFIX_WINDOW}}[0-9])[A-Za-z0-9]{8,}`, 'g'),
  // Stripe/Svix webhook secret: 16+ characters holding a digit or a capital —
  // `whsec_rotation_plan` is a runbook name, and it left this machine as
  // `[REDACTED]_plan`. PARITY: apps/api/src/utils/secretRedaction.js.
  new RegExp(String.raw`(?<![A-Za-z0-9])whsec_(?=[A-Za-z0-9+/=]{0,${PREFIX_WINDOW}}[0-9A-Z])[A-Za-z0-9+/=]{16,${MAX_SECRET}}`, 'g'),
  // AKIA is a long-lived IAM key, ASIA the STS temporary one. The temporary key
  // is the one a session actually prints (`aws sts assume-role`, SSO exports).
  /(?<![A-Za-z0-9])A[KS]IA[0-9A-Z]{16}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g,
  // \b so `pnpm_...` is not read as a token; the 20-character floor keeps
  // npm_config_* / npm_package_* env names (broken up by underscores) out.
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  // Fly prints `FlyV1 fm2_...` (a space) and accepts several macaroons joined by
  // commas; the bare fm1_/fm2_/fo1_ forms are what ends up in an env file.
  /\bFlyV1[ _][A-Za-z0-9_+/=,-]{16,}/g,
  /(?<![A-Za-z0-9])f(?:m1|m2|o1)_[A-Za-z0-9_+/=,-]{16,}/g,
  new RegExp(String.raw`(?<![A-Za-z0-9])xox[baprs]-(?=[A-Za-z0-9-]{0,${PREFIX_WINDOW}}[0-9])[A-Za-z0-9-]{10,}`, 'g'),
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
  // JWT, left-anchored (round 16): unanchored, "eyJeyJ…" was one candidate per
  // three characters, each walking the run to fail — quadratic, 260 ms on 20 KB.
  // A token glued to a URL-encoded separator (`id_token%3DeyJ…`) still counts.
  new RegExp(String.raw`(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2}))eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`, 'g'),
  // Round 15 (PARITY with apps/api/src/utils/secretRedaction.js): GitLab (a
  // digit AND a capital: a lowercase kebab id has none), PyPI, and a Slack
  // incoming-webhook path — the path is the credential, the host stays.
  new RegExp(String.raw`(?<![A-Za-z0-9])glpat-(?=[A-Za-z0-9_.-]{0,${PREFIX_WINDOW}}[0-9])(?=[A-Za-z0-9_.-]{0,${PREFIX_WINDOW}}[A-Z])[A-Za-z0-9_.-]{20,${MAX_SECRET}}`, 'g'),
  new RegExp(String.raw`(?<![A-Za-z0-9])pypi-AgE[A-Za-z0-9_-]{40,${MAX_SECRET}}`, 'g'),
  /(?<=hooks\.slack\.com\/(?:services|workflows|triggers)\/)T[A-Z0-9]{6,16}\/[AB][A-Z0-9]{6,16}\/[A-Za-z0-9]{16,64}/g,
  // Round 16 (PARITY with apps/api/src/utils/secretRedaction.js): Hugging Face
  // (mixed case, so an `hf_` snake id is not one), Shopify, Linear, Doppler.
  // A signed URL's signature IS the credential (Azure SAS `sig=`, S3 / GCS
  // presigned URLs). The URL and its other parameters stay readable.
  /(?<=[?&](?:sig|X-Amz-Signature|X-Goog-Signature)=)[A-Za-z0-9%+/=_-]{16,1024}/g,
  /(?<![A-Za-z0-9_])hf_(?=[A-Za-z0-9]{0,40}[A-Z])(?=[A-Za-z0-9]{0,40}[a-z])[A-Za-z0-9]{30,40}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}(?![A-Za-z0-9])/g,
  new RegExp(String.raw`(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{30,${MAX_SECRET}}`, 'g'),
  new RegExp(String.raw`(?<![A-Za-z0-9.])dp\.(?:pt|st|ct|sa|scim|audit)\.(?:[A-Za-z0-9_-]{1,64}\.)?[A-Za-z0-9]{40,${MAX_SECRET}}`, 'g'),
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

// An optional closing quote (["']?) is allowed between the key name and the
// separator so JSON-quoted keys (e.g. {"api_key": "..."}) still redact — in
// JSON the closing quote sits between the key word-boundary and the `:`.
//
// Two value branches. With a named scheme the value may be short — `Basic dTpw`
// is a whole credential in four characters — and without one the old 8-character
// floor stands. The scheme list is explicit on purpose: the old pattern knew only
// `bearer`, so `Authorization: Basic ...` failed the floor on the word "Basic"
// and the header went out untouched, but a generic "any word" scheme would turn
// "api_key is required" into "api_key is [REDACTED]".
//
// The separator is ':' / '=', or whitespace only when a scheme follows: a bare
// whitespace separator made "Fix authorization middleware ordering" a header
// with the value "middleware". And a value without a scheme needs a digit, '+'
// or '=' (ASSIGNMENT's guard), so "authorization: required." is a sentence.
const AUTH_HEADER = new RegExp(
  String.raw`\b(authorization|x-api-key|api[_-]?key)\b(["']?)(\s*[:=]\s*|\s+(?=(?:bearer|basic|token|negotiate)\s))(?:(["']?)((?:bearer|basic|token|negotiate)\s+)["']?([A-Za-z0-9._\-+/=~]{4,${MAX_SECRET}})|["']?(?=[A-Za-z0-9._\-+/=]{0,${LOOKAHEAD_WINDOW}}[0-9+=])[A-Za-z0-9._\-+/=]{8,${MAX_SECRET}})["']?`,
  'gi',
);
// Prefix before the KEY/TOKEN/SECRET/... suffix is now 0-or-more (not 1-or-more)
// so a bare key name that IS one of the suffix words (e.g. "secret", "token")
// also matches, not just prefixed forms like OPENAI_API_KEY.
// Value guard: a secret value is at least 8 chars, and when unquoted must contain a
// digit or secret-ish symbol. Without this the pattern matched ordinary prose —
// "ADMIN_PASSWORD: contact support" became "[REDACTED] support", and "the auth:
// middleware runs first" lost the word after the colon. That runs at PERSIST time in
// the shared-context normalizers, so it destroyed the stored text irreversibly, not
// just one rendered brief. Biased toward false negatives on purpose: silently
// mangling a user's debugging notes is worse than missing a low-entropy placeholder.
//
// Never re-reads a value an earlier pass already masked: the URI pass leaves
// `https://x-access-token:[REDACTED]@github.com/o/r.git`, and this pattern then saw
// `token:` followed by a long symbol-bearing value and took the host and the repo
// path with it.
//
// Round 14: a bare KEY is not a secret name ("Partition key: tenant_id",
// "cache_key: user:123", "hotkey=ctrl+shift+k"), and the value guard no longer
// admits '-', '_', '.' or '/' — every kebab id, column name and file path — only
// a digit, '+' or '='. Quoted values follow the same guard and hold no
// whitespace, so a quoted sentence is left alone.
const SECRET_NAME = '(?:API|SECRET|PRIVATE|ACCESS|MASTER|SIGNING|ENCRYPTION|CLIENT|AUTH)[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH';
const ASSIGNMENT_GUARD = `(?=[^\\s'";]{0,${LOOKAHEAD_WINDOW}}[0-9+=])`;
// A REFERENCE to a secret is not one: `${API_KEY}`, `${{ secrets.GITHUB_TOKEN }}`,
// `$(gh auth token)`, `$DB_PASSWORD_2`. bcrypt's `$2b$…` still goes.
// Only `${…}`, `$(…)` and a bare `$NAME` that ENDS the value (round 17):
// `DB_PASSWORD=$uperS3cret!` is a password that starts with '$'.
const NOT_A_REFERENCE = String.raw`(?!["']?\$(?:[{(]|[A-Za-z_][A-Za-z0-9_]{0,128}(?![^\s'"\x60;,)}\]&|])))`;
const ASSIGNMENT_VALUE = String.raw`("${ASSIGNMENT_GUARD}[^"\s]{8,${MAX_SECRET}}"|'${ASSIGNMENT_GUARD}[^'\s]{8,${MAX_SECRET}}'|${ASSIGNMENT_GUARD}[^\s'";]{8,${MAX_SECRET}})`;
const ASSIGNMENT = new RegExp(
  String.raw`\b([A-Za-z0-9_]{0,64}(?:${SECRET_NAME}))\b(["']?)(\s*[:=]\s*)(?!\[REDACTED\])${NOT_A_REFERENCE}${ASSIGNMENT_VALUE}`,
  'gi',
);
// An UPPER_SNAKE env var named for a credential (*_KEY_BASE, *_PASS, *_PWD,
// *_CREDENTIALS, and TOKEN / SECRET / PASSWORD in the `:` and JSON forms),
// CASE-SENSITIVELY. *_KEY moved to KEY_NAME_ASSIGNMENT below. PARITY:
// ENV_KEY_ASSIGNMENT in apps/api/src/utils/secretRedaction.js and
// SC_ENV_KEY_ASSIGNMENT in packages/shared-context.
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
// Any name ending in "key" (camelCase, snake, kebab, dotted; any case), but only
// over a SECRET-SHAPED value. Round 15 took UPPER_SNAKE *_KEY on ASSIGNMENT's
// digit guard, which masked `const SEEN_KEY = 'dd_post_sync_modal_seen_v1'`,
// ROUTING_KEY=orders.created.v1 and S3_OBJECT_KEY=exports/2026-09-23.csv in the
// Stop hook, while `AccountKey=<base64>;` and `Ocp-Apim-Subscription-Key: <hex>`
// left the machine whole. PARITY: KEY_NAME_ASSIGNMENT / secretShapedValue in
// apps/api/src/utils/secretRedaction.js, which carries the reasoning.
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
function isIdentifierKeyName(key: string): boolean {
  const snake = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return IDENTIFIER_KEY_NAME.test(snake);
}
// A value that NAMES its digest algorithm is a digest (`integrity:
// sha512-…`, an ssh host key's `SHA256:…` fingerprint), never a secret.
const DIGEST_VALUE = /^(?:sha(?:1|224|256|384|512)|md5|blake2[bs]?|xxh(?:32|64|128|3)?)[-:]/i;
const SECRET_VALUE_PREFIX = /^(?:base64:|key-|SG\.)/;
function secretShapedRun(run: string): boolean {
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
function secretShapedValue(value: string): boolean {
  const v = String(value).replace(/^["']|["']$/g, '');
  if (DIGEST_VALUE.test(v)) return false;
  if (SECRET_VALUE_PREFIX.test(v)) return true;
  // '/' separates a path's segments but is also a base64 character: a piece
  // carrying '+' or '=' is read whole, anything else is split on '/' too.
  return v.split(/[-_.:]+/).some((piece) => (/[+=]/.test(piece) ? secretShapedRun(piece) : piece.split('/').some(secretShapedRun)));
}
// `x-api-key <token>` with no colon (curl -v, most HTTP logs), only when the
// value is secret-shaped: 16+ characters holding a letter and a digit.
const X_API_KEY_SPACE = new RegExp(
  String.raw`\b(x-api-key)(["']?[ \t]{1,16}["']?)(?=[A-Za-z0-9._\-+/=~]{0,${LOOKAHEAD_WINDOW}}[0-9])(?=[A-Za-z0-9._\-+/=~]{0,${LOOKAHEAD_WINDOW}}[A-Za-z])[A-Za-z0-9._\-+/=~]{16,${MAX_SECRET}}`,
  'gi',
);
// The floor and the digit guard above let `PGPASSWORD=pw1 psql ...` and
// `DB_PASSWORD=correcthorse` through whole. Both guards exist to protect prose,
// so this second pass only looks where prose does not live: an UPPER_CASE
// env-style name, a bare `=` with no spaces around it, and a name ending in a
// word that can only be a credential. Bare KEY and AUTH are left out (`SORT_KEY=id`,
// `AUTH=none`), and case is significant so a Python keyword argument
// (`login(token=tok)`) is not touched. A command substitution is not a value,
// and neither is a reference (`${{ secrets.GITHUB_TOKEN }}`, `${API_KEY}`,
// `$OPENAI_API_KEY` — the first left this machine as `[REDACTED] secrets.…`):
// `GH_TOKEN=$(gh auth token)` holds no secret and would be cut in half.
const ENV_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_])([A-Z0-9_]{0,64}(?:PASSWORD|PASSWD|_PWD|SECRET|TOKEN|API_KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY))=(?!["']?\$(?:[{(]|[A-Za-z_][A-Za-z0-9_]{0,128}(?![^\s'"\x60;,)}\]&|]))|\x60)("[^"]{1,${MAX_SECRET}}"|'[^']{1,${MAX_SECRET}}'|[^\s'";&|]{1,${MAX_SECRET}})`,
  'g',
);

// `scheme://user:password@host`. Two holes closed here:
//   - the user part required one character, so `redis://:password@host` — the
//     normal shape for Redis, which has no username — never matched;
//   - the password stopped at the first `@`, so `p@ss` was redacted as `p` and
//     the rest was left in the URL. It now runs greedily to the LAST `@` before
//     the path, which is how a URL parser reads userinfo too.
// A password holding a raw `/` still ends early: that URL is ambiguous to every
// parser, and guessing past the slash would start eating paths. Quotes and angle
// brackets end it too, or compact JSON (`"a":"http://h:80","b":"x@y.io"`) reads
// as one long password reaching for the next field's `@`.
const URI_CREDS = new RegExp(
  String.raw`([a-z][a-z0-9+.-]{0,${URI_SCHEME_MAX}}://[^\s:/@]{0,${URI_PART_MAX}}:)((?:(?!,[a-z][a-z0-9+.-]{0,31}:)[^\s/"'\x60<>\\?#]){1,${URI_PART_MAX}})(@)`,
  'gi',
);

// ─── Credentials passed as command-line flags ────────────────────────────────
//
// Long flags name what they carry, so they are taken wherever they appear and at
// any length: `--token x`. The name must END at the `=` or the space, which is
// what keeps `--password-stdin` and `--token-file path` (neither carries a
// secret) out. The lookbehind makes a run of dashes — a markdown rule, a PEM
// fence — one candidate instead of one per dash.
// The space form also skips the handful of words that follow a flag when it is
// being TALKED about ("pass --token to the CLI", "the --password flag"); the `=`
// form is never prose and skips nothing.
const FLAG_PROSE_WORDS = String.raw`(?!(?:flag|flags|option|options|argument|parameter|value|on|in|to|is|are|was|and|or|for|from|the|a|an|with|when|if|instead)\b)`;
const FLAG_VALUE = String.raw`(?![-<>|&;])("[^"]{0,${MAX_SECRET}}"|'[^']{0,${MAX_SECRET}}'|[^\s'"]{1,${MAX_SECRET}})`;
const LONG_SECRET_FLAG = new RegExp(
  String.raw`(?<![\w-])(--[a-z0-9-]{0,40}(?:password|passwd|token|secret|api[-_]?key))(?:(=)|([ \t]+)${FLAG_PROSE_WORDS})${FLAG_VALUE}`,
  'gi',
);
// Short flags do NOT name what they carry: `-p` is a password to mysql, a port to
// ssh, "parents" to mkdir and "paginate" to git, and `-u` is "unbuffered" to grep.
// So each is only read as a credential after a program that takes one there, in
// the same simple command (the scan stops at `;`, `|`, `&` and a newline). An
// ordinary `ls -p`, `mkdir -p`, `git -p log` or `ssh -p 2222` is never touched.
// A flag's value is on the flag's own line: only spaces and tabs separate them,
// or `mysql -u root -p` (which prompts) would mask the first word of the next line.
// The window stops at the next `curl` (round 16): that one is its own start, and
// letting every `curl -u` rescan the next 1000 characters for a later `-u` made
// "curl -u curl -u …" cost 1000 steps per eight characters.
const CURL_USER_FLAG = new RegExp(
  String.raw`(\bcurl\b(?:(?!\bcurl\b)[^\n;|&]){0,${COMMAND_WINDOW}}?\s(?:-u[ \t]{0,8}|--user(?:[ \t]+|=)))(?:"([^":]{1,${URI_PART_MAX}}):[^"]{1,${MAX_SECRET}}"|'([^':]{1,${URI_PART_MAX}}):[^']{1,${MAX_SECRET}}'|([^\s:'"]{1,${URI_PART_MAX}}):[^\s'"]{1,${MAX_SECRET}})`,
  'g',
);
const TOOL_PASSWORD_FLAG = new RegExp(
  String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump|mongo|mongosh|mongodump|mongorestore|sshpass|(?:docker|podman|nerdctl)\s+login)\b[^\n;|&]{0,${COMMAND_WINDOW}}?\s-p[ \t]{0,8})${FLAG_VALUE}`,
  'g',
);

export function redactSecrets(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  // First: every later pass would otherwise get a chance to break a fence.
  let out = redactPemBlocks(input);
  out = out.replace(URI_CREDS, `$1${REDACTED}$3`);
  // openQuote: `"Authorization": "Bearer <token>"` — a JSON header object puts a
  // quote between the separator and the scheme, and without room for it the
  // whole value went out untouched. It goes back on (and the closing one the
  // trailing `["']?` consumed) so the JSON stays JSON.
  out = out.replace(AUTH_HEADER, (m, key, quote, sep, openQuote, scheme, schemeValue) => {
    // "The Authorization: Basic scheme is ..." — a short all-lowercase word after
    // a scheme name is a sentence. A real Basic value is base64 and a real bearer
    // token is not a lowercase word at any length ("Bearer authentication is
    // required" is a sentence too) — the API's redactor applies the same rule.
    if (scheme && /^[a-z]+$/.test(schemeValue)) return m;
    const close = openQuote && m.endsWith(openQuote) ? openQuote : '';
    return `${key}${quote}${sep}${openQuote || ''}${scheme || ''}${REDACTED}${close}`;
  });
  out = out.replace(LONG_SECRET_FLAG, (_m, flag, eq, space) => `${flag}${eq ?? space}${REDACTED}`);
  out = out.replace(CURL_USER_FLAG, (_m, prefix, dq, sq, bare) => {
    // The user name is kept: it is what makes the log line readable, and it is
    // not the secret. The quotes go back on so the command still parses by eye.
    if (dq !== undefined) return `${prefix}"${dq}:${REDACTED}"`;
    if (sq !== undefined) return `${prefix}'${sq}:${REDACTED}'`;
    return `${prefix}${bare}:${REDACTED}`;
  });
  out = out.replace(TOOL_PASSWORD_FLAG, `$1${REDACTED}`);
  out = out.replace(X_API_KEY_SPACE, (_m, key, sep) => `${key}${sep}${REDACTED}`);
  out = out.replace(ASSIGNMENT, (_m, key, quote, sep) => `${key}${quote}${sep}${REDACTED}`);
  out = out.replace(ENV_KEY_ASSIGNMENT, (_m, key, quote, sep) => `${key}${quote}${sep}${REDACTED}`);
  out = out.replace(TF_TOKEN_ASSIGNMENT, (_m, key, quote, sep) => `${key}${quote}${sep}${REDACTED}`);
  out = out.replace(KEY_NAME_ASSIGNMENT, (m, key, quote, sep, value) => (
    PUBLIC_KEY_NAME.test(key) || isIdentifierKeyName(key) || !secretShapedValue(value) ? m : `${key}${quote}${sep}${REDACTED}`));
  out = out.replace(ENV_ASSIGNMENT, `$1=${REDACTED}`);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}
