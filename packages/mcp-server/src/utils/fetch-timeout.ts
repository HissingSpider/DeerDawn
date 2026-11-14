/**
 * A deadline for `fetch`.
 *
 * An API that accepts the connection and then never answers is not a failure
 * `fetch` reports: without a signal the request simply never settles, and the
 * tool call awaiting it never returns. The axios client already carries a
 * timeout (client.ts) and so does the flush path; the bare `fetch` calls on the
 * auth path did not, which is how a half-open socket could hang a sign-in check
 * for the life of the process.
 *
 * Lived privately in flush-session.ts. Shared now so there is one answer to this
 * question rather than a copy per caller.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Never hold the event loop open for a timer whose only job is to give up.
  (timer as unknown as { unref?: () => void }).unref?.();
  return controller.signal;
}

/**
 * The auth path's deadline. Deliberately shorter than the client's 30s: every
 * call it guards is a small control-plane request (start a device flow, poll for
 * a code, check whether a key is live) sitting in front of a person waiting to
 * sign in, and none of them has any business taking ten seconds.
 */
export const AUTH_FETCH_TIMEOUT_MS = 10_000;
