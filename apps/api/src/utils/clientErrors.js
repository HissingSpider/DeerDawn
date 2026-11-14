/**
 * Client-error classification.
 *
 * Services in this codebase signal "the caller got this wrong, and here is how to
 * fix it" by throwing a plain Error with a `publicMessage` attached. That message
 * is written for the caller to read. But an Error is still just an Error, so
 * unless the route that called it happens to catch that specific code, it reaches
 * the generic handler and is treated as an unexpected 500: the caller gets
 * "An unexpected error occurred", the publicMessage is discarded, clients that
 * retry 5xx hammer the endpoint, and the client's mistake is filed in PostHog
 * Error Tracking as a server defect.
 *
 * That has now happened three times in four days (#263, #277, and
 * workspace_entity_type_invalid), each time fixed by adding one more catch to one
 * more route — which only ever fixes the instance, never the class. So classify
 * centrally instead: `publicMessage` IS the marker of a deliberate client error,
 * and the error handler trusts it. A new validation error is correctly classified
 * the moment it's written, with no route change and no registry entry.
 *
 * STATUS_BY_CODE only exists for codes that aren't a plain 400.
 */

const STATUS_BY_CODE = {
  duplicate_project_name: 409,
  project_has_subprojects: 409,
  parent_project_not_found: 404,
  project_limit_exceeded: 422,
  // Archiving a project that still has live subprojects, and the guard every
  // structural mutation goes through when the project is invisible or is not
  // yours. Both are thrown bare by contextSyncService, neither was classified,
  // and POST /projects/:id/archive and POST /projects/:id/parent pass them
  // straight to next(err) — so archiving a parent project, or a member
  // archiving or moving a colleague's shared project, answered 500 "An
  // unexpected error occurred". A refusal dressed as a server fault tells the
  // caller to retry something that can never work, and files their mistake in
  // Error Tracking as our defect.
  archive_parent_with_children: 409,
  project_not_found: 404,
  project_cannot_parent_itself: 400,
};

// A plain sentence for a bare code the caller can act on. Deliberately tiny:
// new code should attach a publicMessage at the throw site, where the details
// are (which project, how many children). This exists for codes thrown from a
// service, and it never invents a message for a code that is not listed —
// clientErrorBody must stay able to answer with a code alone.
const MESSAGE_BY_CODE = {
  archive_parent_with_children: 'This project still has subprojects. Archive or move them first.',
  project_not_found: 'That project does not exist, or it is not yours to change.',
  project_cannot_parent_itself: 'A project cannot be nested under itself.',
};

// Client errors that predate the publicMessage convention and are still thrown
// bare. Listed explicitly so dropping the old per-route status map doesn't
// silently send them back to the 500 path. New code should attach a
// publicMessage instead of extending this list — a bare code tells the caller
// what broke but not how to fix it.
const BARE_CLIENT_ERROR_CODES = new Set([
  'parent_project_not_found',
  'subproject_depth_exceeded',
  'invalid_project_name',
  'low_value_workspace_entity',
  'archive_parent_with_children',
  'project_not_found',
  'project_cannot_parent_itself',
]);

/**
 * Returns the HTTP status for a deliberate client error, or null if `err` is not
 * one (and so should keep flowing to the 500 path).
 *
 * An explicit `err.status` wins, so a caller can override without a registry edit.
 */
function clientErrorStatus(err) {
  if (!err || typeof err.message !== 'string') return null;
  const hasPublicMessage = typeof err.publicMessage === 'string' && err.publicMessage;
  if (!hasPublicMessage && !BARE_CLIENT_ERROR_CODES.has(err.message)) return null;
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500) return err.status;
  return STATUS_BY_CODE[err.message] || 400;
}

/**
 * Body shape for a client error. Extra fields the thrower attached for recovery
 * (e.g. existing_project_id, so a duplicate-name caller can reuse that project
 * instead of guessing another name) ride along.
 */
function clientErrorBody(err, requestId) {
  const body = { error: err.message };
  if (err.publicMessage) body.message = err.publicMessage;
  else if (MESSAGE_BY_CODE[err.message]) body.message = MESSAGE_BY_CODE[err.message];
  if (err.existing_project_id) body.existing_project_id = err.existing_project_id;
  if (err.upgrade_required) body.upgrade_required = true;
  if (requestId) body.request_id = requestId;
  return body;
}

module.exports = { clientErrorStatus, clientErrorBody, STATUS_BY_CODE, BARE_CLIENT_ERROR_CODES, MESSAGE_BY_CODE };
