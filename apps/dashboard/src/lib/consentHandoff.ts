/**
 * Handing the browser back to the AI tool once the consent screen is approved.
 *
 * THE BUG. The page set `window.location.href = redirect` and showed
 * "Returning to your AI tool…" until the page unloaded. For a web callback
 * (claude.ai, ChatGPT, a loopback CLI) it does. For a native app's private-use
 * scheme (`cursor://…`, `vscode://…`) it never does: the OS opens the app, or
 * asks "Open Cursor?", and the tab stays exactly where it was, saying it is
 * returning forever. If that prompt was dismissed, reloading made it worse: the
 * request had been approved, so the reload read "This connection request is no
 * longer valid" while the authorization code in the redirect was still good.
 *
 * So a native hand-off gets a follow-up state: after a short wait, say the tool
 * should have opened and that the tab can be closed, and keep the same redirect
 * one click away to try the hand-off again.
 */

/** How long to leave "Returning to your AI tool…" up before the follow-up. */
export const NATIVE_HANDOFF_FOLLOW_UP_MS = 1500;

// Never navigated to or rendered as a link, whatever the server sent. The API
// already refuses to register these (routes/oauth.js FORBIDDEN_REDIRECT_SCHEMES);
// this is the same list held at the last step, where an href is built.
const FORBIDDEN_SCHEMES = new Set([
  'javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'filesystem',
  'ftp', 'ws', 'wss', 'mailto', 'view-source', 'chrome', 'chrome-extension', 'moz-extension',
]);

export type ConsentHandoff =
  | { kind: 'web'; href: string }
  | { kind: 'native'; href: string; followUpAfterMs: number }
  | { kind: 'invalid' };

/** How to hand the browser back, from the redirect POST /oauth-approve returned. */
export function planConsentHandoff(redirect: unknown): ConsentHandoff {
  if (typeof redirect !== 'string' || !redirect) return { kind: 'invalid' };
  let parsed: URL;
  try {
    parsed = new URL(redirect);
  } catch {
    return { kind: 'invalid' };
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'https' || scheme === 'http') return { kind: 'web', href: redirect };
  if (FORBIDDEN_SCHEMES.has(scheme)) return { kind: 'invalid' };
  return { kind: 'native', href: redirect, followUpAfterMs: NATIVE_HANDOFF_FOLLOW_UP_MS };
}

function toolName(clientName: string | null | undefined): string | null {
  const trimmed = typeof clientName === 'string' ? clientName.trim() : '';
  return trimmed || null;
}

/** The follow-up headline once a native app should have taken over. */
export function nativeHandoffMessage(clientName: string | null | undefined): string {
  const name = toolName(clientName);
  return `${name || 'Your AI tool'} should have opened. You can close this tab.`;
}

/** The explanation under it: why the retry exists and why a reload will not do. */
export function nativeHandoffHint(clientName: string | null | undefined): string {
  const name = toolName(clientName);
  return `If ${name || 'it'} did not open, or you dismissed the prompt to open it, use the button below. `
    + 'Reloading this page will not work, because this connection is already approved.';
}

/** The retry control's label. */
export function nativeHandoffRetryLabel(clientName: string | null | undefined): string {
  const name = toolName(clientName);
  return name ? `Open ${name} again` : 'Open your AI tool again';
}

/** Said when the redirect is not something this page will open. */
export const INVALID_HANDOFF_MESSAGE =
  'The tool asked to be returned to an address this page will not open. Start the connection again from your AI tool.';
