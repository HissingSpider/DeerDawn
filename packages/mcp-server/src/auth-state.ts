/**
 * Has the stored credential actually been REJECTED, as opposed to merely existing?
 *
 * isAuthed() in surface-state.ts answers "is there a key on disk", and that was
 * standing in for "is this session authenticated" everywhere. The two questions
 * come apart the moment a key expires, and when they do, every recovery path
 * closes at once:
 *
 *   - `authed` stays true, so the SETUP_TIER tools are filtered out of
 *     tools/list — including get_auth_status, the one that hands over the
 *     sign-in link.
 *   - start_session reports "network or service degraded ... retry shortly",
 *     because it collapses every failure into one sentinel. Retrying is not a
 *     fix for an expired key; it is the one remedy guaranteed never to work.
 *
 * Observed 2026-09-04: api.deerdawn.com/healthz served 200 for hours while every
 * context call came back 401 "API Key has expired." The session read as an
 * outage, and a memory product quietly recorded nothing for the duration.
 *
 * Deliberately process-local and not persisted. A restart re-reads the key and
 * optimistically believes it again, which is correct — the key may have been
 * renewed in the meantime — and the first 401 flips this back within one call.
 * Persisting it would risk latching a stale "expired" over a good credential.
 */
let credentialsRejected = false;

/** Called from the client's response interceptor on any 401. */
export function markCredentialsRejected(): void {
  credentialsRejected = true;
}

export function credentialsWereRejected(): boolean {
  return credentialsRejected;
}

// A renewed credential has to reach the LIVE client, or signing in changes
// nothing until the process restarts — and nothing ever tells the user to
// restart. The client bakes the key into an axios instance at construction, so
// it registers here and gets handed the new one.
type CredentialListener = (apiKey: string) => void;
let onCredentialRenewed: CredentialListener | null = null;

export function setCredentialRenewalListener(listener: CredentialListener): void {
  onCredentialRenewed = listener;
}

/** A sign-in completed and produced a working key. Clears the rejection latch. */
export function announceCredentialRenewed(apiKey: string): void {
  credentialsRejected = false;
  try {
    onCredentialRenewed?.(apiKey);
  } catch {
    // A listener that throws must not turn a successful sign-in into a failure.
  }
}

// WHICH KEY THE LIVE CLIENT IS ACTUALLY SENDING.
//
// "A key on disk is valid" and "this process is using it" are two different
// facts, and everything that recovers an expired session was answering the first
// while reporting the second. Two server processes share one HOME — two editor
// windows is the ordinary case, not an exotic one — so when the saved key
// expires and process A signs in again, process B keeps the dead key in the
// axios defaults it built at boot. B's 401 handler then asked get_auth_status,
// which validates the key ON DISK, got {"authenticated":true,"source":"saved"},
// and replied "DeerDawn reconnected. Retry your last message." to a client still
// holding the dead key. Observed looping on that sentence until the host was
// restarted, with the expired key on the wire every time.
//
// Recorded by adoptApiKey in index.ts, which is the one place a key becomes a
// live client, so every route into it is covered. Process-local like the
// rejection latch above, and for the same reason.
let liveApiKey: string | null = null;

/** Called by adoptApiKey once a key is genuinely in the client's headers. */
export function noteLiveCredential(apiKey: string): void {
  const previous = liveApiKey;
  liveApiKey = apiKey || null;
  // REPLACING one live key with a different one is the swap described below.
  // Recorded here rather than at any one call site because there are three
  // routes into it — the pre-emptive read in getClient, the 401 retry, and the
  // renewal announced by get_auth_status — and the first of those is the one
  // that actually fires in practice, while the retry is the one that looks like
  // it does. The FIRST adoption is not a swap: there was nothing to replace.
  if (previous && liveApiKey && previous !== liveApiKey) credentialSwapNotice = true;
}

/** The key the live client holds, or null if no client has been built yet. */
export function liveCredential(): string | null {
  return liveApiKey;
}

// A recovery that lasts only until the next restart, and the user has to be
// told once.
//
// DEERDAWN_API_KEY in the MCP server config outranks credentials.json at every
// boot. When the swap above replaces THAT key with a working saved sign-in, the
// session is fixed and the install is not: the next start reaches for the dead
// key again. get_auth_status has always said so, but a swap can now happen
// without get_auth_status ever being called — from the 401 retry, or from the
// getter re-reading the file — so the sentence has to live with the swap rather
// than with one of its callers. Said once per process; it is advice about a
// config file, not news that repays repeating.
let pinnedEnvKeyNotice = false;

export function notePinnedEnvKeyReplaced(): void {
  pinnedEnvKeyNotice = true;
}

export function consumePinnedEnvKeyNotice(): boolean {
  if (!pinnedEnvKeyNotice) return false;
  pinnedEnvKeyNotice = false;
  return true;
}

// THIS SESSION IS NOW USING A CREDENTIAL IT DID NOT START WITH.
//
// The transparent 401 retry adopts whatever key credentials.json now holds,
// which is right when the same person signed in again in another window and
// wrong when somebody ELSE signed in on a shared machine: the session then goes
// on under their credential, writing this conversation into their memory, with
// nothing to say anything changed.
//
// Which of the two happened cannot be told from here. The key-validation call
// (POST /api/v1/context/search) answers `{ results }` and carries no account
// identity at all; nothing else this client already has does either. A key id
// is `dd_<8 random hex>` minted per KEY, so a renewal by the same person
// produces a brand new prefix — the prefix is identical evidence in both cases.
//
// So: the conservative thing rather than a guess. Still recover, because a
// renewal is the common case and refusing it would restore the very loop the
// recovery exists to end — but never silently. Said once per swap; and every
// in-process project target remembered under the replaced key stops being used,
// which write-target.ts enforces by recording the credential beside each one.
let credentialSwapNotice = false;

export function consumeCredentialSwapNotice(): boolean {
  if (!credentialSwapNotice) return false;
  credentialSwapNotice = false;
  return true;
}

/** Test seam. Nothing in the server calls this. */
export function resetCredentialState(): void {
  credentialsRejected = false;
  onCredentialRenewed = null;
  liveApiKey = null;
  pinnedEnvKeyNotice = false;
  credentialSwapNotice = false;
}
