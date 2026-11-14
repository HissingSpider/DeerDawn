import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { AxiosError } from 'axios';
import { resolveWorkspace, describeWorkspaceClosure, isWorkspaceClosureCode } from '../workspace-override.js';

// Sentinel used by tools/index.ts to trigger auto-reauth instead of showing a raw error
export const AUTH_EXPIRED_SENTINEL = '__DD_AUTH_EXPIRED__';

/**
 * An argument the handler rejected ITSELF — before zod, before the API.
 *
 * Handlers hand-roll a good many of these checks ("phase is required for move
 * action — one of: ..."), and every one of them was thrown as a plain Error. The
 * catch around the whole switch in context-sync.ts routes plain Errors through
 * the no-leak branch below, so the message was replaced with "Operation failed
 * (Error)" and classified InternalError — the same failure the ZodError branch
 * was built to end, one layer over. A caller told "Operation failed" has no
 * reason to think different arguments would help; it retries the same call or
 * gives up.
 *
 * This is the caller's own input, so there is nothing to leak by repeating it
 * back, and InvalidParams says the true thing: fix the arguments and retry.
 */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

// Safe error messages that don't leak sensitive information
const SAFE_ERROR_MESSAGES: Record<number, string> = {
  400: 'Invalid request parameters',
  401: AUTH_EXPIRED_SENTINEL,
  403: 'Access forbidden. Insufficient permissions.',
  404: 'Resource not found',
  409: 'Conflicts with something that already exists',
  422: 'Request could not be processed',
  429: 'Rate limit exceeded. Please try again later.',
  500: 'Internal server error',
  502: 'Bad gateway',
  503: 'Service temporarily unavailable',
  504: 'Gateway timeout',
};

// Error codes whose `message` the API authors specifically for the caller to read
// and act on ("that name is taken, use this project instead"). Collapsing those to
// "Invalid request parameters" strands the agent on a mistake it could have fixed
// itself. Allow-listed by code, never by status, so the default stays no-leak: an
// unexpected 4xx still gets the generic message below.
const ACTIONABLE_ERROR_CODES = new Set([
  'duplicate_project_name',
  'project_name_too_short',
  'project_name_too_long',
  'invalid_project_name',
  'parent_project_not_found',
  'subproject_depth_exceeded',
  'project_limit_exceeded',
  'project_has_subprojects',
  // upsert_workspace_entities. The service writes the exact rule AND the full
  // list of legal entity_types into `message`; without these two codes that
  // message was dropped and the write came back "Invalid request parameters" —
  // while the matching READ (get_workspace_entities) validates its own enums
  // client-side and names the field. That asymmetry is the audited one.
  'workspace_entity_title_required',
  'workspace_entity_type_invalid',
  // A `project` entity whose name two visible projects share: the message lists
  // their ids and says to pass canonical_key "project:<project_id>".
  'workspace_entity_project_ambiguous',
  // A resolve naming a decision by a clipped title two decisions in the project
  // begin with (409), or a decisions/resolve with no title (400): the message
  // says nothing was resolved and what to send instead.
  'decision_title_ambiguous',
  'decision_title_required',
  // resolve_open_question. Both are REFUSALS THAT CARRY THE FIX: the 409 says how
  // many open questions the query fell between and to re-send the exact text, and
  // the 404 names the query that matched nothing. Unlisted, the 409 collapsed to
  // "Conflicts with something that already exists" — a sentence that is not even
  // true here, since nothing was created and nothing conflicts. The handler in
  // tools/context-sync.ts intercepts both status+code pairs and renders the
  // candidate questions itself; these entries are the floor for any other path
  // that reaches this function with the same response.
  'question_ambiguous',
  'question_not_found',
  // Every write refusal in a shared workspace, including the one that now covers
  // upsert_workspace_entities / mark_resolved. The service names the actual fix —
  // which role you hold, or which sections you may not edit, and who can change
  // it — and the hosted dispatcher already passes that through, so dropping it
  // here made the same refusal actionable on one connector and a bare "Access
  // forbidden. Insufficient permissions." on the other. It describes the
  // CALLER'S OWN access to something they can already see, which is why it is
  // safe to repeat: the refusals that would leak somebody else's work are 404s,
  // and those stay generic.
  'share_write_forbidden',
  // The same refusal one store over. A skill write is refused either because the
  // caller's role is read-only or because somebody else wrote the skill, and the
  // service says which — the two have different fixes (ask an owner for a role;
  // ask the author, or publish under another name). Unlisted, both came back as
  // "Access forbidden. Insufficient permissions.", which reads like a broken key
  // and sends the agent to re-authenticate. Same safety argument as above: it is
  // about the caller's own access to a skill they can already read.
  'skill_write_forbidden',
  // A write addressed to an archived project (409). The 30-day idle auto-archive
  // makes this ordinary rather than exotic: the person coming back to dormant
  // work is exactly who hits it. The service's message names the project, says
  // nothing was saved, and gives the restore call; without this entry it became
  // "Conflicts with something that already exists", which is not even true — and
  // the save the user asked for was gone with no way to learn how to get it back.
  'project_archived',
  // A write with no project, from a connection whose own project is no longer
  // shared with the caller (409; journey r5). Its sibling for an ARCHIVED
  // project is the entry above: the same code, with the connection's project
  // named and both ways out spelled out. Unlisted, this became "Conflicts with
  // something that already exists", which is not even true of a refused write.
  'bound_project_unavailable',
  // The same refusal when the project could not be CHECKED (a store error or
  // timeout; 503): nothing was saved, nothing is claimed about the share, retry.
  'bound_project_check_failed',
  // A workspace that is closed rather than a request that is wrong. The branch
  // above handles the case where THIS install targets that workspace, and names
  // it; these entries cover the rest — a personal subscription that lapsed, an
  // org-wide lockdown, and the 409 a write gets from an inactive workspace. The
  // service writes the actual fix into `message` ("ask a workspace owner to
  // update billing"); unlisted, all three collapsed into sentences that send
  // people to the wrong place entirely: "Access forbidden. Insufficient
  // permissions." reads as a broken key, and "Conflicts with something that
  // already exists" is not even true of a refused write.
  'subscription_inactive',
  'lockdown_active',
  'workspace_inactive',
  // upsert_workspace_entities with a summary the service judges too generic to
  // keep ("Workspace entity is too generic to store durably."). The hosted
  // dispatcher relays every publicMessage; locally this was the bare "Invalid
  // request parameters", which says the arguments are malformed when they are
  // well-formed and merely say nothing — the fix is a more specific summary.
  'low_value_workspace_entity',
  // The daily extraction cap (429). The API's message says it is a DAILY limit
  // and when it resets; the generic 429 text says "try again later", which sends
  // an agent into a retry loop against a cap that will not lift for hours.
  'extraction_quota_exceeded',
  // import_trail / export_trail refusals: a malformed, truncated or unsupported
  // .dawn is the caller's to fix, and the service says which of those it is.
  // Every one collapsed to "Invalid request parameters" locally while the hosted
  // connector relayed the reason.
  'trail_invalid',
  'trail_invalid_format',
  'trail_parse_failed',
  'trail_manifest_missing',
  'trail_content_missing',
  'trail_checksum_invalid',
  'trail_unsupported_kind',
  'trail_unsupported_version',
  'trail_export_no_project',
  'trail_fetch_failed',
  'trail_fetch_origin_not_allowed',
  // A session id that belongs to someone else (or no longer exists) is refused
  // with 404 rather than rebound: sessions are author-only. The service says so;
  // generically it read as a missing project.
  'session_not_found',
  // A context PATCH carrying one value over the API's per-value cap is refused
  // whole (400). The service names the field, its length and the limit, and says
  // nothing was saved; generically it read "Request failed with status code 400"
  // (a >4,000-character task) or "Invalid request parameters", neither of which
  // says which field or what to shorten it to.
  'field_too_long',
  // A board write that would leave more open cards than the board holds (409).
  // Open work is never evicted to make room, so the add is refused whole, and the
  // service says how full the board is, which cards were refused and what frees a
  // slot. Generically it read "Conflicts with something that already exists".
  'board_open_limit_reached',
  // record_finding refusals. A malformed note (400, e.g. an unreadable added_at)
  // names the field; a full debugging log answers 409 and says whether it is
  // full of pinned notes or the new note ranked below every stored one.
  // Generically each read as "Invalid request parameters" or a conflict.
  'invalid_debug_finding',
  'debug_log_full_pinned',
  'debug_log_ranked_out',
  // A context write that lost its compare-and-swap on every attempt (409):
  // other writes kept landing on the same project at the same moment, nothing
  // was saved, and the fix is simply to retry. Generically it read as a
  // conflict with "something that already exists", which is not what happened.
  'context_write_conflict',
  // Its sibling from the same write: the caller sent the context_version it had
  // read (expected_context_version) and the brief has moved on since (409).
  // Nothing was saved, and the fix is to read again and re-apply the change.
  // Only the dashboard sends a version today, so no tool on either dispatcher
  // meets this yet; the hosted dispatcher relays every service publicMessage,
  // and this keeps the local server saying the same thing the day one does,
  // instead of "Conflicts with something that already exists".
  // (invalid_expected_context_version is not here on purpose: it is answered
  // by the REST route alone, which the hosted dispatcher never passes through,
  // and it describes a malformed request, not something an assistant can fix.)
  'stale_context_version',
]);

/** Exported for the parity test against the API's own throw sites. */
export function isActionableErrorCode(code: string): boolean {
  return ACTIONABLE_ERROR_CODES.has(code);
}

// An allow-listed message is the service's instruction to the caller, and an
// instruction cut off before its last clause is worse than none. 300 was sized
// for one-sentence refusals; project_archived carries a quoted project name, the
// id twice, and two ways to restore, and ends with the step that completes the
// job ("Then repeat the write."). Still bounded: these strings are written by the
// service for the caller, but they do embed user-chosen names.
const ACTIONABLE_MESSAGE_MAX_CHARS = 800;

// An argument-validation failure is the CALLER'S OWN INPUT, not server data, so
// none of the no-leak reasoning below applies to it — and the caller is a model
// that can correct itself the moment it is told what was wrong.
//
// These used to fall through to the generic Error branch and surface as the bare
// string "Operation failed (ZodError)", with the field-level detail written only
// to stderr where no agent ever sees it. That is unrecoverable by construction:
// the one fact needed to fix the call is the one fact withheld. Reported as
// InvalidParams (the caller's fault, retryable after a fix), never InternalError.
//
// Duck-typed rather than `instanceof ZodError` so it still matches when zod is
// resolved twice in a dependency tree — a real hazard here, since tools and the
// SDK each pull it in.
//
// Matching the SHAPE and not the exact spelling, because zod 4 ships more than
// one error class over the same fields: `zod` and `zod/v4` throw `ZodError`,
// while the `zod/v4-mini` entrypoint throws `$ZodError`. That entrypoint is not
// hypothetical — @modelcontextprotocol/sdk loads it into this process through
// server/zod-compat.js, so both names are live here at once.
//
// The old `!== 'ZodError'` sent a $ZodError to the generic branch at the bottom
// of handleApiError, whose sanitiser strips every non-alphanumeric character
// from the name — turning "$ZodError" back into "ZodError" and reporting
// `Operation failed (ZodError)` as an INTERNAL error. The one error class this
// function exists to classify would have been reported under the name of the
// function that was supposed to have classified it, which is close to
// undiagnosable from the outside: the message names the branch that did not run.
function isZodError(error: any): boolean {
  return /^\$?ZodError$/.test(String(error?.name || '')) && Array.isArray(error?.issues);
}

function formatValidationIssues(error: any): string | null {
  if (!isZodError(error)) return null;
  const issues = error.issues as any[];
  // No field detail is still the caller's own arguments, and still retryable.
  // Falling through to InternalError here would trade a thin message for a wrong
  // classification, which is the more expensive of the two mistakes.
  if (!issues.length) return 'Invalid arguments — the request failed validation, but reported no field-level detail.';

  const parts = issues.slice(0, 6).map((issue: any) => {
    const path = Array.isArray(issue?.path) && issue.path.length ? issue.path.join('.') : '(root)';
    const message = String(issue?.message || 'is invalid');
    // "project_id is required" beats "project_id: Invalid input: expected string,
    // received undefined". zod v3 reports the absence via issue.received; v4
    // folds it into the message and leaves that field unset, so match either —
    // otherwise this branch is dead the moment zod is upgraded, which is exactly
    // what it did here.
    const isMissing = issue?.code === 'invalid_type'
      && (issue?.received === 'undefined' || /received undefined/i.test(message) || /^required$/i.test(message));
    return isMissing ? `${path} is required` : `${path}: ${message}`;
  });
  const more = issues.length > 6 ? ` (+${issues.length - 6} more)` : '';

  // The single most common miss: the model usually holds a project NAME, while
  // every schema wants the id. The name is now accepted (project-ref.ts resolves
  // it centrally), so say that FIRST — the caller can fix the call from what it
  // already has, without a lookup round-trip.
  const mentionsProjectId = issues.some((i: any) => Array.isArray(i?.path) && i.path.includes('project_id'));
  const hint = mentionsProjectId
    ? ' project_id takes the project id ("project_xxxxxxxx-xxxx-...") or the project\'s exact name — or omit it to use the active project. Call recall({ action: "projects" }) to see both.'
    : '';

  return `Invalid arguments — ${parts.join('; ')}${more}.${hint}`;
}

export function handleApiError(error: unknown): never {
  // Already classified, and re-classifying it destroys the classification.
  //
  // A handler may call handleApiError inside its OWN catch to map error codes
  // (import_skill_from_github does), but the catch in handleContextSyncTool
  // wraps the entire switch — so that finished McpError came straight back in
  // here, matched `instanceof Error`, and left as "Operation failed (McpError)".
  // The 401 sentinel travelled the same road, which turned a recoverable
  // "sign in again" into an internal error for every doubly-handled call.
  if (error instanceof McpError) throw error;

  // The caller's own arguments, rejected by a hand-rolled check rather than by
  // zod. Same reasoning as the ZodError branch below, same classification.
  if (error instanceof ToolInputError) throw new McpError(ErrorCode.InvalidParams, error.message);

  const validation = formatValidationIssues(error);
  if (validation) throw new McpError(ErrorCode.InvalidParams, validation);

  if (error instanceof AxiosError) {
    const status = error.response?.status;
    const data = error.response?.data;

    // The workspace header this install sends was refused. Four codes, three
    // fixes: not a member (403 workspace_forbidden), the workspace stopped
    // paying (403 subscription_inactive, or 409 workspace_inactive on a write),
    // or it is locked down (403 lockdown_active).
    //
    // "Access forbidden. Insufficient permissions." reads like a broken
    // credential and sends people to sign in again, which cannot help with any
    // of them; "Conflicts with something that already exists", which is what the
    // unlisted 409 became, is not even true, since nothing was created and
    // nothing conflicts. And a silent fall back to the personal workspace would
    // be worse than either, because the session would then quietly read and
    // write the wrong place. Name the workspace, say where it is configured, and
    // give both ways out. See workspace-override.ts.
    if ((status === 403 || status === 409) && isWorkspaceClosureCode(data?.error)) {
      const targeted = resolveWorkspace();
      if (targeted.workspace) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          describeWorkspaceClosure(targeted.workspace, data.error, targeted.source, targeted.configPath),
        );
      }
    }

    // "Resource not found" for an unknown project is the least useful true
    // sentence available: it names nothing, and the caller cannot tell whether
    // it mistyped, used a name where an id was needed, or is pointing at an
    // archived project. Several routes do send a `message` here, but the
    // allow-list below discards it, and the service usually sets none — so this
    // says what to do instead. The project reference came from the caller, so
    // there is nothing to leak by being specific.
    if (status === 404 && data?.error === 'project_not_found') {
      const detail = typeof data?.message === 'string' && data.message ? ` ${data.message.slice(0, 200)}` : '';
      throw new McpError(
        ErrorCode.InvalidParams,
        `No project matches that reference.${detail} project_id takes either the id ("project_xxxxxxxx-xxxx-...") or the project's exact name. Call recall({ action: "projects" }) to list them, or omit project_id to use the active project. Archived projects are not in that list — restore one with manage_projects({ action: "restore", project_id: "<its name>" }).`,
      );
    }

    // Use safe error messages by default to prevent information leakage
    const safeMessage = SAFE_ERROR_MESSAGES[status || 500] || 'Request failed';

    // Only include field-level validation errors for 400 responses
    let detailedMessage = safeMessage;
    if (
      typeof data?.error === 'string'
      && ACTIONABLE_ERROR_CODES.has(data.error)
      && typeof data?.message === 'string'
      && data.message
    ) {
      detailedMessage = data.message.slice(0, ACTIONABLE_MESSAGE_MAX_CHARS);
    } else if (status === 400 && data?.error?.field && typeof data.error.field === 'string') {
      // Safe to include field validation errors (sanitize the field name)
      const sanitizedField = data.error.field.replace(/[^a-zA-Z0-9_.-]/g, '');
      detailedMessage = `${safeMessage}: invalid ${sanitizedField}`;
    }

    // Determine appropriate MCP error code
    const errorCode =
      status === 401 || status === 403
        ? ErrorCode.InvalidRequest
        : status === 400 || status === 404 || status === 409 || status === 422
        ? ErrorCode.InvalidParams
        : ErrorCode.InternalError;

    throw new McpError(errorCode, detailedMessage);
  }

  if (error instanceof Error) {
    // Never expose internal error messages that might contain sensitive data.
    // We do emit a sanitized class hint for debugging recurring runtime failures.
    const rawName = String(error.name || 'RuntimeError');
    // `$` survives: stripping it is what let "$ZodError" print as "ZodError" and
    // impersonate a class this function handles two branches up.
    const safeName = rawName.replace(/[^a-zA-Z0-9_$]/g, '').slice(0, 32) || 'RuntimeError';
    const rawMessage = String(error.message || '');
    const safeMessage = rawMessage.replace(/[^a-zA-Z0-9 .,_:-]/g, '').slice(0, 120);
    process.stderr.write(`[DeerDawn][runtime-error] ${safeName}${safeMessage ? `: ${safeMessage}` : ''}\n`);
    throw new McpError(ErrorCode.InternalError, `Operation failed (${safeName})`);
  }

  throw new McpError(ErrorCode.InternalError, 'Unknown error occurred');
}
