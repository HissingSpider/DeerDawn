/**
 * What /onboarding can honestly show someone who has not signed up yet.
 *
 * THE ASYMMETRY THIS CLOSES. The public /connect page has no auth gate and hands
 * the connector URL and the setup command to anyone who asks. The dashboard's
 * own setup flow asked for an account first — so the same two strings sat behind
 * a signup form, and a reader who wanted to see what they were committing to had
 * to commit first. Over the measured window, 55 accounts produced 20 first
 * sessions and 25 of the 55 abandoned the signup form.
 *
 * WHY IT IS SAFE, SPECIFICALLY. Neither value is account-scoped. `REMOTE_MCP_URL`
 * is `https://api.deerdawn.com/mcp` — one hosted server, the same host for every
 * user — and `ONE_COMMAND_SETUP` is `npx -y @deerdawn/mcp-server@latest setup`,
 * a published package with no key in it. There is no per-account token, project
 * id, or workspace slug anywhere in the setup path: identity is established by
 * the browser OAuth round trip the tool performs on first connect, not by the
 * string you paste. That is exactly why /connect can be public, and it is the
 * only reason this preview is allowed to exist.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 *  - No placeholder. Nothing is rendered that resembles a real value but is not
 *    one — a fake URL that has to be re-copied after signup is worse than no URL,
 *    because the reader has no way to know which of the two they hold.
 *  - No agent setup prompt. `AGENT_SETUP_PROMPT` tells the reader's AI to install
 *    and CONNECT DeerDawn end to end, which runs into an OAuth screen that has no
 *    account to authorize. The URL and the command stop cleanly at that point and
 *    say so; the prompt would strand someone mid-install.
 *  - No authenticated request. The preview reads nothing from the API. That is
 *    the condition on which AuthProvider lets a signed-out reader render this
 *    page at all — see PREVIEW_PAGES there.
 *
 * The values are imported from `connectCopy.ts` rather than restated, so the
 * preview cannot drift from the post-signup page it is a preview OF. That file is
 * mirrored with marketing's copy and pinned by a module-comparison test; nothing
 * here writes to it.
 */
import { ONE_COMMAND_SETUP, REMOTE_MCP_URL, REMOTE_SETUP_LOCATIONS } from '@/lib/connectCopy';

/** Where the preview's primary CTA goes. Signup already lands back on /onboarding. */
export const PREVIEW_SIGNUP_ROUTE = '/signup';

/** ...and the secondary, for a reader who already has an account on another device. */
export const PREVIEW_SIGNIN_ROUTE = `/login?redirect_url=${encodeURIComponent('/onboarding')}`;

export type PreviewSetupItem = {
  id: 'connector_url' | 'one_command';
  /** Column heading. */
  label: string;
  /** The real, copyable value — never a sample. */
  value: string;
  /** Who this one is for, so the reader takes the right of the two. */
  detail: string;
};

/**
 * The two things a reader can take away before they have an account, in the
 * order the connect step itself offers them: the URL covers every tool with a
 * connector menu, the command covers Claude Code.
 */
export const PREVIEW_SETUP: PreviewSetupItem[] = [
  {
    id: 'connector_url',
    label: 'The connector URL',
    value: REMOTE_MCP_URL,
    detail: 'For Claude, ChatGPT, Cursor, VS Code — anywhere you can add a custom or remote MCP server.',
  },
  {
    id: 'one_command',
    label: 'Or one command, for Claude Code',
    value: ONE_COMMAND_SETUP,
    detail: 'Registers the server, installs the capture hooks, and opens your browser to sign in.',
  },
];

/** Where each tool keeps the setting, straight from the shared copy module. */
export const PREVIEW_LOCATIONS = REMOTE_SETUP_LOCATIONS;

/**
 * What an account actually changes — stated plainly, because the alternative is
 * a reader who copies the URL, pastes it, and hits an authorization screen with
 * no warning.
 *
 * Every line is a fact about the flow, not a benefit: the first is why the
 * paste alone cannot finish, and the other two are what this page does once
 * there is a session behind it.
 */
export const WHAT_SIGNING_IN_ADDS: string[] = [
  'The tool opens a DeerDawn tab the first time it connects and asks you to authorize it. That step needs an account — it is where the connection gets attached to somewhere your briefs can live.',
  'This page then watches for the connection and tells you the moment it lands, so you are not guessing whether the paste worked.',
  'And it walks you through the first brief, so your next session opens on something rather than on nothing.',
];

/**
 * Does this string give away nothing that belongs to one account?
 *
 * A guard for the values above rather than a general-purpose validator. The
 * preview is safe only while the strings in it stay account-agnostic, and the
 * way that changes is not a rewrite — it is somebody interpolating a workspace
 * id or a key into one of them later, on a page that no longer asks for a login
 * first. This is what the test asserts against, so that edit fails loudly.
 */
export function isAccountAgnostic(value: string): boolean {
  const scoped: RegExp[] = [
    // Credential-shaped prefixes used across this codebase and its vendors.
    /\b(?:sk|pk|rk|whsec|dd|ddk|user|org|proj|prj|sload)_[A-Za-z0-9]/i,
    // A UUID: every per-account identifier we mint is one.
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    // Anything handed over in a query string: token, key, id, email, account.
    /[?&](?:api_?key|token|access_token|key|secret|user|user_id|email|account|org|org_id|workspace|project|project_id)=/i,
    // A bare JWT.
    /\beyJ[A-Za-z0-9_-]{8,}\./,
    // An email address.
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    // An unresolved template hole — the shape a real interpolation leaves behind.
    /\$\{|\{\{|<[A-Za-z_]+>|YOUR_[A-Z_]+/,
  ];
  return !scoped.some((pattern) => pattern.test(value));
}
