import fs from 'fs';
import path from 'path';
import { AxiosError, AxiosHeaders } from 'axios';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { AUTH_EXPIRED_SENTINEL, ToolInputError, handleApiError, isActionableErrorCode } from '../src/utils/errors.js';

function apiError(status: number, data: unknown): AxiosError {
  const err = new AxiosError('Request failed with status code ' + status);
  err.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  } as AxiosError['response'];
  return err;
}

function thrownBy(error: unknown): McpError {
  try {
    handleApiError(error);
  } catch (thrown) {
    return thrown as McpError;
  }
  throw new Error('handleApiError should always throw');
}

describe('handleApiError', () => {
  it('passes through the API message for allow-listed, actionable error codes', () => {
    const err = thrownBy(apiError(409, {
      error: 'duplicate_project_name',
      message: 'duplicate_project_name: a project named "Atlas" already exists (project_abc). Use that project, or pick a different name.',
      existing_project_id: 'project_abc',
    }));

    // The whole point: the caller can fix this itself, but only if it's told how.
    expect(err.message).toContain('already exists');
    expect(err.message).toContain('project_abc');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('passes through the archived-project refusal whole, restore call included', () => {
    // Built the way the API builds it (contextSyncService.archivedProjectError),
    // with a long-but-legal project name: the old 300-character cap cut this
    // message off in the middle of the instruction that fixes it.
    const id = 'project_0b9b2c1e-7a43-4c58-9f0e-2d6a1c3e5f70';
    const name = 'Payments platform migration to the new ledger service (2026)';
    const message = `project_archived: "${name}" (${id}) is archived, so nothing was saved. `
      + 'A restore is required before it can be written to: manage_projects with action "restore", '
      + `or POST /api/v1/context/projects/${id}/archive with {"unarchive": true}. Then repeat the write.`;
    expect(message.length).toBeGreaterThan(300);

    const err = thrownBy(apiError(409, { error: 'project_archived', message }));

    expect(err.message).toContain(message);
    expect(err.message).not.toContain('Conflicts with something that already exists');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('passes through why a skill write was refused', () => {
    const err = thrownBy(apiError(403, {
      error: 'skill_write_forbidden',
      message: 'Only the person who wrote this skill, or a workspace owner, can replace it.',
    }));

    expect(err.message).toContain('Only the person who wrote this skill');
    expect(err.message).not.toContain('Insufficient permissions');
    expect(err.code).toBe(ErrorCode.InvalidRequest);
  });

  it('passes through the refusal a read-only caller can act on', () => {
    // The service writes the exact fix into `message` — which role you hold, and
    // who can change it. Without the allow-list entry that became "Access
    // forbidden. Insufficient permissions.", which names nothing and leaves the
    // agent retrying. The hosted dispatcher already surfaces this text, so
    // withholding it locally is a drift between the two connectors, not caution:
    // the message describes the caller's OWN role on something they can already
    // see, and leaks nothing about anybody else's work.
    const err = thrownBy(apiError(403, {
      error: 'share_write_forbidden',
      blocked_fields: [],
      message: 'share_write_forbidden: you have read-only (viewer) access to this workspace, so nothing was saved. Ask a workspace owner to make you a member.',
    }));

    expect(err.message).toContain('read-only (viewer) access');
    expect(err.message).toContain('Ask a workspace owner');
    expect(err.code).toBe(ErrorCode.InvalidRequest);
  });

  it('passes through a stale-version refusal: nothing was saved, read again', () => {
    // Built the way the API builds it (contextSyncService.staleContextVersionError).
    // The hosted dispatcher relays every service publicMessage, so this one reads
    // the same on both connectors instead of "Conflicts with something that
    // already exists" here, which is not what happened.
    const message = 'stale_context_version: the brief for "Acme storefront" changed after this copy of it was read. '
      + 'Nothing was saved. Read it again and re-apply the change to what is there now.';
    const err = thrownBy(apiError(409, { error: 'stale_context_version', code: 'stale_context_version', message }));

    expect(err.message).toContain('Nothing was saved');
    expect(err.message).toContain('Read it again');
    expect(err.message).not.toContain('Conflicts with something that already exists');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('keeps the generic message for error codes that are not allow-listed', () => {
    const err = thrownBy(apiError(409, {
      error: 'some_internal_conflict',
      message: 'row 42 of table users conflicts with constraint users_pkey',
    }));

    expect(err.message).not.toContain('users_pkey');
    expect(err.message).toContain('Conflicts with something that already exists');
  });

  it('does not leak the body of an unexpected server error', () => {
    const err = thrownBy(apiError(500, {
      error: 'internal_error',
      message: 'An unexpected error occurred.',
    }));

    expect(err.message).toContain('Internal server error');
    expect(err.message).not.toContain('An unexpected error occurred');
    expect(err.code).toBe(ErrorCode.InternalError);
  });
});

/**
 * Argument validation used to be unrecoverable by construction (2026-08-29).
 *
 * A ZodError from a tool's own schema fell through to the generic Error branch
 * and reached the caller as the bare string "Operation failed (ZodError)" —
 * classified InternalError, with the field-level detail written only to stderr.
 * The one fact needed to fix the call was the one fact withheld, and because it
 * read as an INTERNAL error the caller had no reason to think retrying with
 * different arguments would help. Reads validated and said "resource not found";
 * writes threw. That asymmetry was this.
 *
 * The caller here is a model: an error that says what was wrong and what shape is
 * expected gets fixed on the next call.
 */
describe('handleApiError: argument validation', () => {
  const zodError = (issues: unknown[]) => Object.assign(new Error('Invalid input'), { name: 'ZodError', issues });

  it('names the missing field instead of "Operation failed (ZodError)"', () => {
    const err = thrownBy(zodError([
      { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['project_id'], message: 'Required' },
    ]));
    expect(err.message).not.toContain('Operation failed');
    expect(err.message).toContain('project_id is required');
  });

  it('classifies it as the caller\'s error, not an internal one', () => {
    // InternalError tells a model "nothing you can do"; InvalidParams tells it
    // "fix the arguments and retry", which is the truth.
    const err = thrownBy(zodError([
      { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['summary'], message: 'Required' },
    ]));
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('tells the caller how to obtain a project_id, since it usually holds a name', () => {
    const err = thrownBy(zodError([
      { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['project_id'], message: 'Required' },
    ]));
    expect(err.message).toContain('recall({ action: "projects" })');
  });

  it('reports several bad fields at once, and caps the list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      code: 'invalid_type', expected: 'string', received: 'undefined', path: [`field${i}`], message: 'Required',
    }));
    const err = thrownBy(zodError(many));
    expect(err.message).toContain('field0 is required');
    expect(err.message).toContain('+3 more');
  });

  it('leaves genuine runtime errors sanitized', () => {
    // The no-leak default still applies to everything that is NOT the caller's
    // own arguments.
    const err = thrownBy(new TypeError('secret internal detail'));
    expect(err.message).toContain('Operation failed (TypeError)');
    expect(err.message).not.toContain('secret internal detail');
    expect(err.code).toBe(ErrorCode.InternalError);
  });
});

/**
 * The tests above hand-build the error object. This one drives a REAL zod parse
 * failure, so a zod upgrade that reshapes `issues` fails here rather than
 * silently reverting every validation message to "Operation failed (ZodError)".
 */
describe('handleApiError: against a real zod failure', () => {
  it('formats what zod actually produces', async () => {
    const { z } = await import('zod');
    const schema = z.object({ project_id: z.string().min(1), summary: z.string().min(1) });
    let raw: unknown;
    try {
      schema.parse({});
    } catch (e) {
      raw = e;
    }
    const err = thrownBy(raw);
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).not.toContain('Operation failed');
    // Real zod v4 folds "received undefined" into the message and leaves
    // issue.received unset — the missing-field branch must still fire.
    expect(err.message).toContain('project_id is required');
    expect(err.message).toContain('summary is required');
    expect(err.message).toContain('recall({ action: "projects" })');
  });
});

/**
 * "Resource not found" for an unknown project (2026-08-29).
 *
 * It is the least useful true sentence available: it names nothing, and the
 * caller cannot tell whether it mistyped, used a name where an id was needed, or
 * is pointing at an archived project — which are three different fixes. Several
 * routes do send a `message` alongside project_not_found, but ACTIONABLE_ERROR_CODES
 * discarded it and the service usually sets none.
 */
describe('handleApiError: an unknown project', () => {
  it('says what a project reference may be, instead of "Resource not found"', () => {
    const err = thrownBy(apiError(404, { error: 'project_not_found' }));
    expect(err.message).not.toContain('Resource not found');
    expect(err.message).toContain('No project matches');
    // The three fixes a caller might need.
    expect(err.message).toContain('exact name');
    expect(err.message).toContain('recall({ action: "projects" })');
    expect(err.message).toContain('restore');
  });

  it('is the caller\'s error, so it is retryable rather than internal', () => {
    const err = thrownBy(apiError(404, { error: 'project_not_found' }));
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('keeps a message the API bothered to write', () => {
    const err = thrownBy(apiError(404, {
      error: 'project_not_found',
      message: 'Project was deleted on 2026-08-01.',
    }));
    expect(err.message).toContain('Project was deleted on 2026-08-01.');
  });

  it('leaves other 404s alone', () => {
    // The no-leak default still governs everything that is not the caller's own
    // project reference.
    const err = thrownBy(apiError(404, { error: 'skill_not_found' }));
    expect(err.message).toContain('Resource not found');
    expect(err.message).not.toContain('No project matches');
  });
});

/**
 * The rest of the argument-validation surface (2026-08-29 audit).
 *
 * The ZodError branch above covers arguments a SCHEMA rejected. Handlers reject a
 * good many themselves — "phase is required for the move action — one of: ..." —
 * and every one of those was a plain Error, so it took the no-leak path and
 * reached the caller as "Operation failed (Error)", classified InternalError. The
 * message was already safe to show: it is the caller's own input, written by us,
 * for the caller to act on.
 */
describe('handleApiError: an argument the handler rejected itself', () => {
  it('keeps the message and calls it the caller\'s error', () => {
    const err = thrownBy(new ToolInputError('Unknown phase "in-review". Valid phases: backlog, blocked.'));

    expect(err.message).toContain('Unknown phase "in-review"');
    expect(err.message).toContain('backlog');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('does not treat it as a runtime failure to be sanitized', () => {
    const err = thrownBy(new ToolInputError('import_trail: dry_run must be true or false (got "maybe").'));
    expect(err.message).not.toContain('Operation failed');
  });
});

/**
 * An error that arrives here already classified.
 *
 * A handler may call handleApiError inside its own catch; the wrapper around the
 * whole switch then catches what that throws and calls it again. The second pass
 * matched `instanceof Error` and replaced a finished InvalidParams — message,
 * code and all — with "Operation failed (McpError)".
 */
describe('handleApiError: a second pass over its own output', () => {
  it('returns the McpError untouched', () => {
    const first = thrownBy(apiError(404, { error: 'project_not_found' }));
    const second = thrownBy(first);

    expect(second).toBe(first);
    expect(second.message).toContain('No project matches');
    expect(second.code).toBe(ErrorCode.InvalidParams);
  });

  it('carries the auth sentinel through instead of burying it', () => {
    // This is not a message — it is the signal tools/index.ts watches for to open
    // a device flow. A second pass turned an expired token into an internal error.
    const err = thrownBy(thrownBy(apiError(401, {})));
    expect(err.message).toContain(AUTH_EXPIRED_SENTINEL);
  });

  it('is CONTAINED in the message, never equal to it', () => {
    // McpError's constructor rewrites the message as `MCP error ${code}: ${msg}`,
    // so the equality test tools/index.ts used to run could never be true and the
    // whole reauth branch was dead. What the user saw instead was the raw
    // sentinel string presented as an explanation.
    const err = thrownBy(apiError(401, {}));
    expect(err.message).not.toBe(AUTH_EXPIRED_SENTINEL);
    expect(err.message).toContain(AUTH_EXPIRED_SENTINEL);
  });
});

/**
 * Write-path validation the API authors a message for.
 *
 * The READ (get_workspace_entities) validates its own enums client-side and names
 * the field. The WRITE (upsert_workspace_entities) sends entity_type to the
 * server, which rejects it with the rule AND the full list of legal values — and
 * the allow-list here dropped that message and answered "Invalid request
 * parameters". Same class as the ZodError case, one layer further out.
 */
/**
 * resolve_open_question's two refusals.
 *
 * Both are refusals that CARRY THE FIX, which is the only kind worth passing
 * through. The 409 is the sharper case: unlisted, SAFE_ERROR_MESSAGES rewrote it
 * to "Conflicts with something that already exists" — not merely unhelpful but
 * false, since nothing was created and nothing conflicts. A caller reading that
 * has no reason to think a differently-worded question would work.
 *
 * The handler in tools/context-sync.ts intercepts both status+code pairs and
 * renders the candidate questions itself. This is the floor beneath it, for any
 * other path that reaches handleApiError with the same response.
 */
describe('handleApiError: resolving one open question', () => {
  it('does not turn an ambiguous question into a phantom conflict', () => {
    const err = thrownBy(apiError(409, {
      error: 'question_ambiguous',
      message: '"auth" matches 2 open questions, so nothing was resolved. Re-send the exact, complete question text.',
      candidates: ['How should I authenticate with GitHub?', 'Which auth provider should the dashboard use?'],
    }));

    expect(err.message).not.toContain('already exists');
    expect(err.message).toContain('nothing was resolved');
    expect(err.message).toContain('exact, complete question text');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('says which question missed, instead of "Resource not found"', () => {
    const err = thrownBy(apiError(404, {
      error: 'question_not_found',
      message: 'No open question matches "Which colour should the logo be?".',
    }));

    expect(err.message).not.toBe('Resource not found');
    expect(err.message).toContain('Which colour should the logo be?');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });
});

describe('handleApiError: entity write rejections', () => {
  it('passes through the list of legal entity types', () => {
    const err = thrownBy(apiError(400, {
      error: 'workspace_entity_type_invalid',
      message: 'workspace_entity_type_invalid: entities[].entity_type is required and must be one of: service, decision, knowledge',
    }));

    expect(err.message).not.toBe('Invalid request parameters');
    expect(err.message).toContain('must be one of');
    expect(err.message).toContain('decision');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('passes through the title rule', () => {
    const err = thrownBy(apiError(400, {
      error: 'workspace_entity_title_required',
      message: 'workspace_entity_title_required: entities[].title (or the `name` alias) is required and must be at least 3 characters.',
    }));

    expect(err.message).toContain('at least 3 characters');
  });

  it('still says nothing about an error code nobody allow-listed', () => {
    const err = thrownBy(apiError(400, { error: 'some_internal_rule', message: 'column node_type violates check constraint' }));
    expect(err.message).not.toContain('node_type');
  });
});

/**
 * zod 4 ships two error classes over one shape, and the process holds both.
 *
 * `zod` / `zod/v4` throw `ZodError`; `zod/v4-mini` throws `$ZodError`. The MCP
 * SDK loads v4-mini itself (server/zod-compat.js), so both are live here. An
 * exact-name check missed the second, and the generic branch's sanitiser then
 * stripped the `$` and reported `Operation failed (ZodError)` as -32603 — the
 * classifier's own name on the failure it was written to prevent.
 *
 * Observed as a real cluster: 51 opaque `Operation failed (ZodError)` calls
 * between 2026-07-24 and 2026-08-31, field detail written only to stderr.
 */
// Resolved at module load, NOT inside an `it`. vitest resolving a bare specifier
// it has not seen before can outlast the 5s per-test budget on a cold cache, and
// that surfaces as a timeout on the assertion rather than on the import.
const zodClassic = require('zod');
const zodMini = require('zod/v4-mini');

describe('a validation failure from either zod entrypoint', () => {
  const thrownBy = (fn: () => void): any => {
    try { fn(); } catch (error) { return error; }
    throw new Error('expected a validation failure');
  };

  it('classifies the classic ZodError with its field detail', () => {
    const z = zodClassic.z;
    const err = thrownBy(() => z.object({ project_id: z.string() }).parse({}));
    expect(err.name).toBe('ZodError');

    const mcp = thrownBy(() => handleApiError(err));
    expect(mcp.code).toBe(ErrorCode.InvalidParams);
    expect(mcp.message).toContain('project_id is required');
  });

  it('classifies the mini $ZodError the same way, instead of calling it internal', () => {
    const zm = zodMini;
    const err = thrownBy(() => zm.parse(zm.object({ project_id: zm.string() }), {}));
    // The precondition that made this invisible: same shape, different name.
    expect(err.name).toBe('$ZodError');
    expect(Array.isArray(err.issues)).toBe(true);

    const mcp = thrownBy(() => handleApiError(err));
    expect(mcp.code).toBe(ErrorCode.InvalidParams);
    expect(mcp.message).toContain('project_id');
    expect(mcp.message).not.toContain('Operation failed');
  });

  it('never lets an unknown error impersonate ZodError by losing its $', () => {
    // The sanitiser, not the classifier: a class this function does NOT handle
    // must not be printed under the name of one it does.
    const impostor = Object.assign(new Error('boom'), { name: '$SomethingElse' });
    const mcp = thrownBy(() => handleApiError(impostor));

    expect(mcp.code).toBe(ErrorCode.InternalError);
    expect(mcp.message).toContain('$SomethingElse');
  });

  it('still refuses to classify a plain object wearing the name', () => {
    const mcp = thrownBy(() => handleApiError(Object.assign(new Error('x'), { name: 'ZodError' })));
    expect(mcp.code).toBe(ErrorCode.InternalError);
  });
});

/**
 * The hosted dispatcher relays EVERY service error that carries a
 * publicMessage (mcpSafety.normalizeMcpError); this one relays only an
 * allow-list. The two drifted: `low_value_workspace_entity` ("too generic to
 * store durably") reached a hosted caller whole and a local one as "Invalid
 * request parameters", as did every .dawn refusal and the daily extraction cap.
 */
describe('handleApiError: parity with the codes the API writes for the caller', () => {
  it('relays the too-generic entity refusal', () => {
    const err = thrownBy(apiError(400, {
      error: 'low_value_workspace_entity',
      message: 'Workspace entity is too generic to store durably.',
    }));
    expect(err.message).toContain('Workspace entity is too generic to store durably.');
    expect(err.message).not.toContain('Invalid request parameters');
    expect(err.code).toBe(ErrorCode.InvalidParams);
  });

  it('relays the daily extraction cap instead of "try again later"', () => {
    const err = thrownBy(apiError(429, {
      error: 'extraction_quota_exceeded',
      message: 'Daily extraction limit reached. Resets within 24 hours.',
    }));
    expect(err.message).toContain('Resets within 24 hours');
    expect(err.message).not.toContain('Please try again later');
  });

  it('relays why a .dawn was refused', () => {
    const err = thrownBy(apiError(400, {
      error: 'trail_checksum_invalid',
      message: 'trail_checksum_invalid: the Trail content does not match its checksum; it was modified or truncated.',
    }));
    expect(err.message).toContain('does not match its checksum');
  });

  // Drift guard: read the API's throw sites and require every code that carries
  // a publicMessage to be relayed here, unless it is listed below with the
  // reason this client can never receive it.
  const NOT_REACHABLE_LOCALLY: Record<string, string> = {
    project_not_found: 'has its own branch in handleApiError, with a fix-it sentence',
    share_forbidden: 'share links are minted from the dashboard; no local tool calls the share routes',
    share_requires_upgrade: 'same: dashboard-only share routes',
    share_scan_unresolved: 'same: dashboard-only share routes',
    trail_publish_blocked: 'publishing a Trail is dashboard-only; export_trail writes a private file',
  };

  it('allow-lists every publicMessage code the API throws that this client can receive', () => {
    const apiSrc = path.resolve(__dirname, '..', '..', '..', 'apps', 'api', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(apiSrc);
    const codes = new Set<string>();
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const match = line.match(/new Error\('([a-z_]+)'\)/);
        if (!match) return;
        // The publicMessage is attached within a few lines of the throw site.
        if (lines.slice(i, i + 6).some((l) => /\.publicMessage\s*=/.test(l))) codes.add(match[1]);
      });
    }
    expect(codes.size, 'found no publicMessage throw sites — the scan is broken').toBeGreaterThan(10);
    const missing = [...codes].filter((code) => !isActionableErrorCode(code) && !(code in NOT_REACHABLE_LOCALLY));
    expect(missing, 'relayed by the hosted dispatcher but collapsed to a generic sentence here').toEqual([]);
  });
});
