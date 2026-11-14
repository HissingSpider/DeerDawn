// Canonical connect / setup copy — the single source of truth for how users wire
// DeerDawn into their AI tools. Everything that can drift (the remote URL, the
// per-tool menu locations, the install commands, the system-prompt snippets) lives
// here so the dashboard onboarding, settings pages, and marketing site can't tell
// three different stories.
//
// MIRROR of apps/marketing/src/lib/connectCopy.ts. The apps are separate Next
// builds, so the file is duplicated rather than shared; treat this copy as
// authoritative and mirror any edit into marketing.
//
// NOT byte-for-byte, despite what this comment used to claim. Marketing
// deliberately carries no em dashes in user-facing strings (79e24c00 — "an
// AI-writing tell"). The invariant is: identical export names, identical tool
// keys, and byte-identical command/URL/config values; prose may differ only in
// that punctuation. Enforced by apps/marketing/tests/connect-copy-mirror.test.ts.

// Hosted literals throughout; forThisDeployment / SELF_HOSTED_API_URL point them
// at a self-hosted install's own API instead (see connectTarget.ts). They live
// in their own module so this one keeps exactly marketing's export names.
import { HOSTED_API_URL, SELF_HOSTED_API_URL, forThisDeployment } from './connectTarget';

export const DEERDAWN_API_URL = SELF_HOSTED_API_URL || HOSTED_API_URL;
export const REMOTE_MCP_URL = `${DEERDAWN_API_URL}/mcp`;
export const CLAUDE_REMOTE_MCP_URL = `${REMOTE_MCP_URL}/claude`;
export const AGENT_SETUP_URL = 'https://deerdawn.com/agent-setup/prompt.md';

// One portable bootstrap prompt for agentic and chat-only clients. The hosted
// guide detects the current client, routes to the matching instructions, and
// keeps the user out of MCP settings whenever the host can configure itself.
export const AGENT_SETUP_PROMPT = `Fetch and follow the DeerDawn setup instructions at ${AGENT_SETUP_URL}. Detect which AI tool you are running in, install or configure DeerDawn for me, pause only when I need to approve an action or sign in, then verify the connection and help me save my first project brief.`;

// Claude Code can't paste a URL into a settings menu — it registers MCP servers
// through its CLI. The remote form is the recommended, no-API-key path.
export const CLAUDE_CODE_REMOTE_CMD = `claude mcp add -s user --transport http deerdawn ${CLAUDE_REMOTE_MCP_URL}`;

// One command, whole setup: browser sign-in, `claude mcp add`, the SessionStart/
// Stop capture hooks, and ~/.claude/CLAUDE.md — see runSetup() in
// packages/mcp-server/src/index.ts. It is the primary Claude Code path because
// every step it absorbs is a step the user could previously get wrong: of the 11
// people who copied an MCP config in the 14 days to 2026-08-19, 8 never connected.
//
// Claude Code ONLY. runSetup never writes ~/.codex/config.toml — for Codex it
// merely refreshes ~/.codex/AGENTS.md if that file already exists — so this must
// not be sold as the Codex path.
//
// Self-hosted: the same command with --api-url, so it signs in to, registers and
// points the hooks at this install (resolveSetupApiUrl in setup-plan.ts).
export const ONE_COMMAND_SETUP = 'npx -y @deerdawn/mcp-server@latest setup'
  + (SELF_HOSTED_API_URL ? ` --api-url ${SELF_HOSTED_API_URL}` : '');

// Codex's own MCP CLI, which registers the hosted server and starts OAuth without
// the user opening a config file. Mirrors the shipped agent-setup/codex.md guide.
export const CODEX_CLI_SETUP_CMDS = `codex mcp add deerdawn --url ${REMOTE_MCP_URL}
codex mcp login deerdawn`;

// Local (advanced) install. Claude Code does NOT read ~/.claude/mcp.json — the
// server must be registered via this command, which is why the local path is also
// a CLI command and not a file to paste.
export const CLAUDE_CODE_LOCAL_CMD = `claude mcp add -s user deerdawn -e DEERDAWN_API_URL=${DEERDAWN_API_URL} -e DEERDAWN_SURFACE_ID=claude_code -- npx -y @deerdawn/mcp-server@latest`;

// Generic local MCP config (Cursor, Claude Desktop, ChatGPT Desktop, etc.).
// The URL is inlined (not interpolated) so this stays byte-identical to the
// shared package's canonical formatMcpJsonConfig() — enforced by the
// shared-context contract test.
// forThisDeployment() is identity on hosted, so the hosted value is that literal.
export const LOCAL_NPX_CONFIG_JSON = forThisDeployment(`{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com"
      }
    }
  }
}`);

// Inlined to stay byte-identical to the canonical formatCodexMcpTomlConfig().
export const CODEX_TOML_CONFIG = forThisDeployment(`[mcp_servers.deerdawn]
command = "npx"
args = ["-y", "@deerdawn/mcp-server@latest"]
startup_timeout_sec = 120

[mcp_servers.deerdawn.env]
DEERDAWN_API_URL = "https://api.deerdawn.com"`);

// Hosted Cursor config: the "url" entry the Cursor row of REMOTE_SETUP_LOCATIONS
// tells people to add. That row named the entry and no page showed it, so the
// only copyable Cursor JSON anywhere was the LOCAL npx block, which is a
// different install. Interpolated from REMOTE_MCP_URL so it cannot drift from
// the URL every other surface prints.
//
// It carries NO credential and must not. Cursor signs in through the browser
// (OAuth) against this URL, and the file it goes into is one people commit.
export const CURSOR_REMOTE_CONFIG_JSON = `{
  "mcpServers": {
    "deerdawn": {
      "url": "${REMOTE_MCP_URL}"
    }
  }
}`;

// Where the connector form lives in the two browser tools, and the steps that
// follow. ONE definition: by 2026-09 this path existed three times and the three
// disagreed. The per-tool table said "Settings, Connectors" for Claude.ai, the
// dashboard setup card said "settings, then Integrations" (a menu Claude.ai
// renamed), and onboarding hard-coded its own copy. A user following the card
// looked for a menu that is not there. REMOTE_SETUP_LOCATIONS, the /setup
// cards, the onboarding phone step and the /connect guides all read this now.
export interface ConnectorMenuPath {
  /** The settings pane that holds the connector list. */
  menu: string;
  /** The control inside that pane that opens the form. */
  action: string;
  /** Anything the form asks that the URL alone does not answer. */
  formNote: string;
}

export type ConnectorTool = 'Claude.ai' | 'ChatGPT.com';

export const CONNECTOR_MENU_PATHS: Record<ConnectorTool, ConnectorMenuPath> = {
  'Claude.ai': { menu: 'Settings → Connectors', action: 'Add custom connector', formNote: 'Leave the OAuth client fields blank.' },
  'ChatGPT.com': { menu: 'Settings → Connectors', action: 'Add MCP server', formNote: 'Choose OAuth as the authentication type.' },
};

/** "Settings → Connectors → Add custom connector": the one-line form of a path. */
export function connectorMenuLine(tool: ConnectorTool): string {
  const path = CONNECTOR_MENU_PATHS[tool];
  return `${path.menu} → ${path.action}`;
}

/** The numbered steps for one browser tool, built from the same path. */
export function connectorSetupSteps(tool: ConnectorTool): string[] {
  const path = CONNECTOR_MENU_PATHS[tool];
  return [
    `Open ${path.menu} and choose ${path.action}.`,
    `Paste the DeerDawn MCP URL. ${path.formNote}`,
    'Click Connect. A DeerDawn tab opens. Sign in and approve the connection.',
  ];
}

// The anchors on deerdawn.com/connect that a per-tool "Full guide" link may
// point at, keyed by the dashboard setup card id. The link used to be built as
// `/connect#${tool.id}` for all nine cards while the page defined four ids, so
// six of the nine links opened the top of a long page. The dashboard builds its
// link from this list and marketing/tests/connect-anchors.test.tsx renders
// /connect and fails if any of these ids is missing from the markup.
export const CONNECT_GUIDE_ANCHORS: string[] = [
  'claude-code',
  'cursor',
  'codex',
  'claude-desktop',
  'claude-ai',
  'chatgpt-desktop',
  'chatgpt-com',
  'gemini',
  'perplexity',
];

/** The /connect fragment for a setup card, or null when the page has no guide for it. */
export function connectGuideAnchor(toolId: string): string | null {
  return CONNECT_GUIDE_ANCHORS.includes(toolId) ? `#${toolId}` : null;
}

export interface RemoteSetupLocation {
  tool: string;
  where: string;
  /**
   * What the user actually has to touch. The table used to present all seven
   * rows as equivalent, which hid a real fork: two of these need NOTHING
   * installed and can be finished in a browser on a phone (one user did it in
   * 28 seconds), while others need an editor open or a terminal command. A
   * visitor deciding whether they can start right now needs that distinction
   * before they need the menu path.
   */
  setupVia: 'browser' | 'app' | 'terminal';
}

// Where the "add a remote MCP server / connector" setting lives in each tool. The
// URL + browser sign-in is identical everywhere — only the menu differs.
export const REMOTE_SETUP_LOCATIONS: RemoteSetupLocation[] = [
  { tool: 'Claude.ai', where: connectorMenuLine('Claude.ai'), setupVia: 'browser' },
  { tool: 'ChatGPT.com', where: `${connectorMenuLine('ChatGPT.com')} (choose OAuth)`, setupVia: 'browser' },
  { tool: 'Cursor', where: 'Settings → MCP → Add server, or add a "url" entry in .cursor/mcp.json', setupVia: 'app' },
  { tool: 'Claude Code', where: `Run ${ONE_COMMAND_SETUP}`, setupVia: 'terminal' },
  // Codex had no picker entry at all, so a Codex user landed on the catch-all
  // ("add a custom remote MCP server with the URL") — advice for a settings menu
  // Codex does not have. It registers servers through its CLI, like Claude Code.
  { tool: 'Codex', where: 'Run codex mcp add deerdawn --url … then codex mcp login deerdawn', setupVia: 'terminal' },
  { tool: 'VS Code / Copilot', where: 'Command palette → MCP: Add Server → HTTP → paste the URL', setupVia: 'app' },
  { tool: 'Windsurf, Gemini, others', where: 'Add a custom remote / HTTP MCP server with the URL', setupVia: 'app' },
];

// The universal three-step browser sign-in. Plain strings so any renderer can use
// them; pages add their own emphasis/markup.
export const SIGN_IN_STEPS: string[] = [
  'In your AI tool, add a custom / remote MCP server (sometimes called a connector) and paste the URL above. Leave any OAuth client fields blank.',
  'Click Connect. A DeerDawn tab opens — sign in and press Connect to authorize.',
  'You’re returned to your tool, and the DeerDawn tools (start_session, recall, manage_memory, …) are ready to use.',
];

// What the optional local install adds on top of the universal URL.
export const ADVANCED_LOCAL_BULLETS: string[] = [
  'Writes .deerdawn-context.md / .cursorrules into your repo so context loads with no tool call.',
  'Installs SessionStart / Stop hooks that capture and flush context automatically.',
];

// "Make it automatic" — drop-in instructions so the AI calls DeerDawn on its own.
export const CLAUDE_AI_SYSTEM_PROMPT = `At the start of every conversation, silently call start_session from DeerDawn before responding. Use the returned context (current task, decisions, stack) to answer without asking me to re-explain the project.

If start_session includes a "Since last session" catch-up, open with at most two sentences: the most meaningful change, anchored in time ("Last session (yesterday) you shipped X"), then the open thread as an offer ("Y is still open — want to pick that up?"). Then stop and let me steer. Do not recite the full brief. If nothing changed, confirm readiness in one line. Never invent progress, decisions, or landmines that are not in the context.

After any of the following, call manage_memory with action "update" and a 1-2 sentence summary:
- A decision is made
- The task or status changes
- Something meaningful is built or fixed
- I confirm an approach ("yes", "good", "do it", "ship it")

Do not mention that you are calling these tools unless I ask.`;

export const CHATGPT_SYSTEM_PROMPT = `At the start of every conversation, call start_session from DeerDawn before responding. Use the returned context to orient yourself — current task, recent decisions, open questions — without asking me to re-explain.

If start_session includes a "Since last session" catch-up, open with at most two sentences: the top change anchored in time, then the open thread as an offer. Do not recite the full brief; if nothing changed, confirm readiness in one line. Never invent progress that is not in the context.

After any decision, task change, or meaningful progress, call manage_memory with action "update" and a brief summary of what changed and why.

Call these tools silently. Do not narrate the tool calls unless I ask.`;

// Where each tool keeps its always-on instructions, and which prompt belongs there.
//
// Measured 2026-08-26: of the 8 accounts that have ever completed an MCP
// handshake, 3 have never produced a single tool call — and their connectors
// keep re-handshaking (11 times; one user's Claude.ai loaded DeerDawn again on
// day 7 and still called nothing). A connector is not a trigger. Nothing invokes
// start_session unless the user asks for it, or unless a standing instruction in
// the tool tells the model to. That standing instruction is the difference
// between a connected account and a used one, and it lived only on step 2 of
// onboarding, below the fold, as a secondary button — after the step the silent
// users had already left.
//
// `where` is the tool's own instruction surface, not ours: a settings pane for
// the web tools, a file on disk for the CLIs. Wrong-but-close beats absent —
// every entry names a real location, and the catch-all says so plainly.
export interface AutomationSetup {
  where: string;
  prompt: string;
}

export const AUTOMATION_SETUP: Record<string, AutomationSetup> = {
  'Claude.ai': { where: 'Settings → Capabilities → Personal preferences (or a Project’s instructions)', prompt: CLAUDE_AI_SYSTEM_PROMPT },
  'ChatGPT.com': { where: 'Settings → Personalization → Custom instructions', prompt: CHATGPT_SYSTEM_PROMPT },
  'Cursor': { where: 'Settings → Rules → User Rules, or .cursorrules in the repo', prompt: CLAUDE_AI_SYSTEM_PROMPT },
  'Claude Code': { where: '~/.claude/CLAUDE.md (or ./CLAUDE.md for one project)', prompt: CLAUDE_AI_SYSTEM_PROMPT },
  'Codex': { where: '~/.codex/AGENTS.md (or ./AGENTS.md for one project)', prompt: CHATGPT_SYSTEM_PROMPT },
  'VS Code / Copilot': { where: '.github/copilot-instructions.md', prompt: CLAUDE_AI_SYSTEM_PROMPT },
  'Windsurf, Gemini, others': { where: 'your tool’s custom instructions or rules file', prompt: CLAUDE_AI_SYSTEM_PROMPT },
};

// Fallback for a tool that is not in the map — never leave the step without one.
export const DEFAULT_AUTOMATION_SETUP: AutomationSetup = {
  where: 'your tool’s custom instructions or rules file',
  prompt: CLAUDE_AI_SYSTEM_PROMPT,
};
