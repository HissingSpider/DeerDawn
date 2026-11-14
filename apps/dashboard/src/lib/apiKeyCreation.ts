/**
 * Creating the first API key, which is the most important step a new account
 * takes and the one where a bad error message costs the whole activation.
 *
 * THE BUG. /setup defaulted the name to 'Primary key' and branched on
 * `message.includes('conflict')`. POST /api/v1/keys answers 409 with
 * `{ error: 'conflict', message: 'An active API Key with this name already
 * exists.' }` — the word "conflict" is in the CODE, never in the message the
 * client throws — so that branch could never match. A second unnamed key, and a
 * viewer's 403 (a viewer's role cannot grant context:write), both rendered as
 * "Failed to create key.": no reason, no way forward, at the step everything
 * else depends on.
 */

/** What the setup page names a key when the person does not. */
export const DEFAULT_KEY_NAME = 'Primary key';

/**
 * The next name to try when the default is already taken.
 *
 * A duplicate default is not really the person's mistake — they left the field
 * alone twice — so the second attempt picks a name rather than handing them an
 * error to solve. It is tried ONCE; a second conflict is reported, because at
 * that point something is wrong that renaming will not fix.
 */
export function nextDefaultKeyName(existingAttempt: number): string {
  return `${DEFAULT_KEY_NAME} ${Math.max(2, existingAttempt + 1)}`;
}

export type KeyCreateFailure = { status?: number; data?: Record<string, unknown> | null; message?: string };

/** Is this the duplicate-name refusal? Read from the STATUS and the error CODE,
 *  never from the prose, which is what the old `includes('conflict')` did. */
export function isDuplicateKeyName(err: KeyCreateFailure): boolean {
  return err.status === 409 || err.data?.error === 'conflict';
}

/**
 * Retry silently with a distinct default name?
 *
 * Only when the conflict is on a name the page chose. A name the person typed
 * is theirs; quietly creating "my-laptop 2" for them would be the page deciding
 * something it was not asked to decide.
 */
export function shouldRetryWithNewName(err: KeyCreateFailure, usedDefaultName: boolean): boolean {
  return usedDefaultName && isDuplicateKeyName(err);
}

/**
 * What to show when the key could not be created.
 *
 * The server's own sentence wins wherever it sent one: keys.js names the
 * duplicate, and names the scopes a role cannot grant ("Your role in this
 * workspace cannot grant: context:write"), which is the only form of this
 * failure the reader can actually act on.
 */
export function describeKeyCreateFailure(err: KeyCreateFailure): string {
  const serverMessage = typeof err.data?.message === 'string' && err.data.message.trim()
    ? err.data.message.trim()
    : '';
  if (isDuplicateKeyName(err)) {
    return serverMessage || 'An active key with this name already exists. Give this one a different name.';
  }
  if (err.status === 403) {
    return serverMessage || 'Your role in this workspace cannot create an API key. Ask a workspace owner.';
  }
  if (err.status === 401) {
    return 'Your session expired. Sign in again, then create the key.';
  }
  if (err.status === 429) {
    return serverMessage || 'Too many attempts. Wait a moment and try again.';
  }
  return serverMessage || 'Could not create the key. Try again, and contact support if it keeps failing.';
}

/**
 * What revoking a key that could not be revoked should say.
 *
 * THE BUG. /setup branched on `message.includes('404')`, but ApiError.message is
 * the parsed body (`not_found`), never the status. So a key that was already
 * gone (revoked in another tab, or by a workspace owner) read "Failed to revoke
 * key", and a 403 hid the server's own sentence, which is the one that says WHY
 * ("This key belongs to someone else..."). Read the STATUS, and prefer the
 * server's words.
 *
 * `alreadyGone` means the outcome the person wanted is already true: the list
 * should be re-read and nothing reported as a failure.
 */
export function describeKeyRevokeFailure(err: KeyCreateFailure): { alreadyGone: boolean; message: string } {
  if (err.status === 404) {
    return { alreadyGone: true, message: 'That key was already revoked.' };
  }
  const serverMessage = typeof err.data?.message === 'string' && err.data.message.trim()
    ? err.data.message.trim()
    : '';
  if (err.status === 403) {
    return { alreadyGone: false, message: serverMessage || 'You cannot revoke this key. Ask a workspace owner.' };
  }
  if (err.status === 401) {
    return { alreadyGone: false, message: 'Your session expired. Sign in again, then revoke the key.' };
  }
  return { alreadyGone: false, message: serverMessage || 'Could not revoke the key. Try again, and contact support if it keeps failing.' };
}

/**
 * WHAT A KEY MINTED HERE CAN DO, NOT ONLY WHERE IT BELONGS.
 *
 * The key panel told every teammate "Anything an agent writes with one lands in
 * that workspace". POST /keys narrows a default key to what the role can grant,
 * so a VIEWER's key is read-only: an agent using it writes nothing anywhere, and
 * the sentence promised the opposite. Said from the bound workspace's role before
 * minting, and from the scopes the server actually granted after.
 */
export type KeyScopeWorkspace = { name: string | null; personal: boolean; role: string | null };

/** The sentence at the top of the key panel. */
export function keyWorkspaceSentence(scope: KeyScopeWorkspace): string {
  const name = scope.name || null;
  if (scope.personal) {
    return name
      ? `Keys you create here belong to ${name}, your own workspace.`
      : 'Keys you create here belong to your own workspace.';
  }
  const label = name || 'this workspace';
  if ((scope.role || '').toLowerCase() === 'viewer') {
    return `Keys you create here can read ${label} but not write to it, because your role there is viewer. An agent using one can load its briefs and cannot save anything.`;
  }
  return `Keys you create here belong to ${label}. Anything an agent writes with one lands in that workspace, not in your own.`;
}

/**
 * The scopes POST /keys granted, wherever the response carries them. Null when
 * it does not say (an API that predates the field), which is NOT "read-only".
 */
export function grantedKeyScopes(response: unknown): string[] | null {
  if (!response || typeof response !== 'object') return null;
  const body = response as { scopes?: unknown; key?: { scopes?: unknown } | null };
  const scopes = Array.isArray(body.scopes) ? body.scopes : Array.isArray(body.key?.scopes) ? body.key?.scopes : null;
  if (!Array.isArray(scopes)) return null;
  return scopes.filter((scope): scope is string => typeof scope === 'string');
}

/** Shown beside a freshly minted key whose scopes cannot write, else null. */
export function mintedKeyAccessNote(scopes: string[] | null, workspaceName: string | null): string | null {
  if (!scopes) return null;
  if (scopes.includes('context:write') || scopes.includes('context:admin')) return null;
  return `This key can read ${workspaceName || 'this workspace'} but not write to it. An agent using it can load briefs and cannot save anything.`;
}
