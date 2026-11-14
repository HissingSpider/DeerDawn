import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { EyeIcon, EyeOffIcon } from '@/components/icons';
import { DashboardTableWrap } from '@/components/dashboard/PageScaffold';
import { DisclosureRow } from '@/components/dashboard/brief/DisclosureRow';
import { SecondToolNudge } from '@/components/dashboard/brief/SecondToolNudge';
import { showToast } from '@/components/ui/Toast';
import {
  api,
  getActiveWorkspace,
  getWorkspaceFallbackKey,
  isApiError,
  onWorkspaceListing,
  PERSONAL_SWITCH_FAILED_MESSAGE,
  switchToPersonalWorkspace,
  type HostedConnection,
  type WebCaptureTool,
  type WorkspaceConfig,
  type WorkspacesListing,
} from '@/lib/api';
import {
  credentialWorkspace,
  credentialWorkspaceWarning,
  type CredentialWorkspace,
} from '@/lib/workspaceFallback';
import {
  DEFAULT_KEY_NAME,
  describeKeyCreateFailure,
  describeKeyRevokeFailure,
  grantedKeyScopes,
  keyWorkspaceSentence,
  mintedKeyAccessNote,
  nextDefaultKeyName,
  shouldRetryWithNewName,
} from '@/lib/apiKeyCreation';
import { logger } from '@/lib/logger';
import { siteConfig } from '@/lib/siteConfig';
import { trackProductEvent } from '@/lib/productAnalytics';
import {
  REMOTE_MCP_URL,
  ONE_COMMAND_SETUP,
  CODEX_CLI_SETUP_CMDS,
  LOCAL_NPX_CONFIG_JSON,
  connectorSetupSteps,
  connectGuideAnchor,
} from '@/lib/connectCopy';
import { connectionEvidence } from '@/lib/connectionEvidence';
import { transportLabel, usageFromHealth } from '@/lib/toolUsage';

const MARKETING_URL = siteConfig.PRIMARY_SITE_URL;
const SUPPORT_EMAIL = 'support@deerdawn.com';
// A surface that hasn't called DeerDawn in this many days is treated as drifted.
const STALE_DAYS = 14;

const TROUBLESHOOTING_STEPS = [
  'Restart your AI tool after adding the config.',
  'Confirm the config was copied exactly, including the closing brace.',
  'Run your tool’s auth/status check and complete the one-time browser sign-in.',
  'Re-copy the MCP config and paste it again if the tool shows no DeerDawn server.',
  'Open the dashboard and confirm your workspace exists.',
];

type ToolId =
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'claude-desktop'
  | 'claude-ai'
  | 'chatgpt-desktop'
  | 'chatgpt-com'
  | 'gemini'
  | 'perplexity';

// Per-surface MCP usage from sync_health.mcp_surfaces (see apps/api dashboard route).
type McpSurfaceUsage = {
  surface: string;
  start_sessions: number;
  start_session_skips: number;
  update_contexts: number;
  tool_calls: number;
  last_called_at: string | null;
  call_rate: number | null;
  /** Handshakes (mcp_runtime_started) on this surface. Absent on an older API. */
  handshakes?: number;
  /** How the calls arrived (local install, hosted connection), when the API says. */
  transports?: string[];
};

const SURFACE_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  claude_desktop: 'Claude Desktop',
  claude_web: 'Claude.ai',
  chatgpt_web: 'ChatGPT',
  unknown_web: 'Web (unidentified)',
  unknown: 'Unknown',
};

function surfaceLabel(surface: string): string {
  return SURFACE_LABELS[surface] || surface;
}

// Days since a surface last called DeerDawn (null if never seen).
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

function relativeDays(days: number | null): string {
  if (days === null) return 'never';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

const LS_PREFIX = 'deerdawn_connected_';

// Map real MCP surface names (underscored, web aliases) to AI-tool card ids, so
// the connected badge can reflect actual server-side call data rather than a
// per-browser, self-attested localStorage flag that lies across devices.
const SURFACE_TO_TOOL: Record<string, string> = {
  claude_code: 'claude-code',
  cursor: 'cursor',
  codex: 'codex',
  claude_web: 'claude-ai',
  chatgpt_web: 'chatgpt-com',
  gemini: 'gemini',
  perplexity: 'perplexity',
};

// The surfaces the hosted endpoint can name a web tool by.
const HOSTED_WEB_SURFACES = new Set(['claude_web', 'chatgpt_web']);

function hasCalls(usage: McpSurfaceUsage | null | undefined): boolean {
  return Boolean(usage && (usage.tool_calls > 0 || usage.start_sessions > 0));
}

/**
 * Per-card usage, keyed by card id.
 *
 * HOSTED CALLS THAT NAME NO CLIENT. The hosted endpoint is stateless and used to
 * file every tools/call as 'unknown_web', so a working Claude.ai connection read
 * as a handshake beside calls no card maps to: "0 of 9 tools connected". Calls
 * are now labelled from the OAuth credential, but the rows already written are
 * not rewritten, and a credential minted before keys carried their client's
 * name still names none. Those calls are credited to a web tool here, and only
 * when that cannot be a guess: exactly ONE web tool introduced itself (an
 * identified handshake), and NO unidentified client did — Cursor, VS Code and
 * Codex handshake as 'unknown_web', and any of them could have made every one
 * of these calls. Two candidates, or none, and the calls stay nobody's; the next
 * call on a named credential lands on its card by itself.
 */
function usageByToolId(surfaces: McpSurfaceUsage[]): Map<string, McpSurfaceUsage> {
  const map = new Map<string, McpSurfaceUsage>();
  for (const u of surfaces) {
    const id = SURFACE_TO_TOOL[u.surface] || u.surface.replace(/_/g, '-');
    const existing = map.get(id);
    // Keep the most recently active record if a tool maps from several surfaces.
    if (!existing || (u.last_called_at ?? '') > (existing.last_called_at ?? '')) map.set(id, u);
  }

  const unidentified = surfaces.find((u) => u.surface === 'unknown_web');
  if (!unidentified || !hasCalls(unidentified) || (unidentified.handshakes ?? 0) > 0) return map;
  const introduced = surfaces.filter((u) => HOSTED_WEB_SURFACES.has(u.surface) && (u.handshakes ?? 0) > 0);
  if (introduced.length !== 1) return map;

  const id = SURFACE_TO_TOOL[introduced[0].surface];
  const own = map.get(id) ?? introduced[0];
  map.set(id, {
    ...own,
    start_sessions: own.start_sessions + unidentified.start_sessions,
    start_session_skips: own.start_session_skips + unidentified.start_session_skips,
    update_contexts: own.update_contexts + unidentified.update_contexts,
    tool_calls: own.tool_calls + unidentified.tool_calls,
    last_called_at: (unidentified.last_called_at ?? '') > (own.last_called_at ?? '')
      ? unidentified.last_called_at
      : own.last_called_at,
  });
  return map;
}

// The cards whose tool can ONLY reach DeerDawn over a hosted OAuth connection.
// While one holds no credential it is not connected, whatever its calls say.
const HOSTED_ONLY_TOOLS = new Set<string>(['claude-ai', 'chatgpt-com']);

/**
 * Which card each hosted connection belongs on.
 *
 * Placed by the connection's own NAME (the API's `surface`, read from the name
 * the client registered), never by where its metadata lives or by elimination:
 * a Disconnect on the wrong card would cut off the wrong tool. A connection
 * that names nothing Setup has a card for, or no name at all, goes in `other`,
 * where it can still be seen and disconnected.
 */
function connectionsByTool(connections: HostedConnection[]): {
  byTool: Map<ToolId, HostedConnection[]>;
  other: HostedConnection[];
} {
  const byTool = new Map<ToolId, HostedConnection[]>();
  const other: HostedConnection[] = [];
  for (const connection of connections) {
    const toolId = SURFACE_TO_TOOL[connection.surface] as ToolId | undefined;
    if (connection.identified && toolId && AI_TOOLS.some((tool) => tool.id === toolId)) {
      byTool.set(toolId, [...(byTool.get(toolId) ?? []), connection]);
    } else {
      other.push(connection);
    }
  }
  return { byTool, other };
}

/**
 * One card's state. A card is connected when its tool has made real calls in the
 * window (a handshake alone is not a connection: connecting is not a trigger),
 * and "installed" when this browser was told so and nothing has called yet.
 *
 * A HOSTED TOOL IS CONNECTED WHILE IT HOLDS A CREDENTIAL. Its calls stay in the
 * 30-day window after it is disconnected, so without this a ChatGPT the person
 * had just cut off read "connected" again on the next visit, with nothing on the
 * row to disconnect. Gated only when the listing is known (null: an older API,
 * or the read failed, and the row reads as before) and only when no connection
 * in it is unnamed, because an unnamed one could be this very tool.
 */
function toolRowState({ toolId, usage, selfAttested, connections }: {
  toolId: ToolId;
  usage: McpSurfaceUsage | undefined;
  selfAttested: boolean;
  connections: HostedConnection[] | null;
}): { days: number | null; state: ToolState } {
  const days = daysSince(usage?.last_called_at ?? null);
  let seen = hasCalls(usage);
  if (seen && connections && HOSTED_ONLY_TOOLS.has(toolId)) {
    const holdsOne = connectionsByTool(connections).byTool.has(toolId);
    const couldBeIt = connections.some((connection) => !connection.identified);
    if (!holdsOne && !couldBeIt) seen = false;
  }
  let state: ToolState = 'off';
  if (seen && days !== null && days >= STALE_DAYS) state = 'stale';
  else if (seen) state = 'live';
  else if (selfAttested) state = 'installed';
  return { days, state };
}

/**
 * What a failed disconnect says. Shaped like describeKeyRevokeFailure
 * (lib/apiKeyCreation), which the key-revoke button on this page uses, so the
 * two destructive actions here fail the same way: a 404 means it is already
 * gone, and the server's own sentence wins when it gave one.
 */
function describeDisconnectFailure(err: {
  status?: number;
  data?: Record<string, unknown>;
}): { alreadyGone: boolean; message: string } {
  if (err.status === 404) {
    return { alreadyGone: true, message: 'That app was already disconnected.' };
  }
  const serverMessage = typeof err.data?.message === 'string' && err.data.message.trim()
    ? err.data.message.trim()
    : '';
  if (err.status === 403) {
    return { alreadyGone: false, message: serverMessage || 'You cannot disconnect this app from here.' };
  }
  if (err.status === 401) {
    return { alreadyGone: false, message: 'Your session expired. Sign in again, then disconnect the app.' };
  }
  return { alreadyGone: false, message: serverMessage || 'Could not disconnect the app. Try again, and contact support if it keeps failing.' };
}

/** A connection's resource URL, shown as its path ("/mcp/claude"): which endpoint, not whose host. */
function endpointPath(resource: string): string {
  try {
    return new URL(resource).pathname || resource;
  } catch {
    return resource;
  }
}

function getConnected(toolId: ToolId): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(LS_PREFIX + toolId) === 'true';
}

function setConnectedFlag(toolId: ToolId, value: boolean) {
  if (value) {
    localStorage.setItem(LS_PREFIX + toolId, 'true');
  } else {
    localStorage.removeItem(LS_PREFIX + toolId);
  }
}

const AI_TOOLS: Array<{
  id: ToolId;
  name: string;
  subtitle: string;
  description: string;
  setupSteps?: string[];
  // When set, this tool installs via a browser userscript (no remote MCP) and
  // the setup panel shows a one-click download instead of the MCP endpoint.
  userscriptTool?: WebCaptureTool;
}> = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    subtitle: 'local MCP',
    description: 'CLI coding assistant from Anthropic. Connects via local npx MCP server.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    subtitle: 'local MCP',
    description: 'AI-powered code editor. Add a single config snippet and restart.',
  },
  {
    id: 'codex',
    name: 'Codex',
    subtitle: 'remote MCP',
    description: 'OpenAI terminal coding agent. Registers the hosted server through its own CLI.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    subtitle: 'local MCP',
    description: 'Anthropic desktop app. One config file, no API key needed.',
  },
  {
    id: 'claude-ai',
    name: 'Claude.ai',
    subtitle: 'remote MCP',
    description: 'Claude in the browser. Add DeerDawn as a custom connector, then authorize.',
    // From connectCopy, not typed here. This card used to say "settings, then
    // Integrations", a menu Claude.ai no longer has, while /connect and
    // onboarding said Connectors: three pages, three paths to one form.
    setupSteps: connectorSetupSteps('Claude.ai'),
  },
  {
    id: 'chatgpt-desktop',
    name: 'ChatGPT Desktop',
    subtitle: 'local MCP',
    description: 'OpenAI desktop app. Config file location varies by OS.',
  },
  {
    id: 'chatgpt-com',
    name: 'ChatGPT.com',
    subtitle: 'remote MCP',
    description: 'ChatGPT in the browser. Add DeerDawn as a custom MCP connector, then authorize.',
    setupSteps: connectorSetupSteps('ChatGPT.com'),
  },
  {
    id: 'gemini',
    name: 'Gemini',
    subtitle: 'browser userscript',
    description: 'No MCP support — DeerDawn syncs context via a lightweight userscript.',
    userscriptTool: 'gemini',
    setupSteps: [
      'Install a userscript manager (Tampermonkey or Violentmonkey).',
      'Click “Download userscript” below.',
      'Open the downloaded file — your manager will prompt to install it.',
      'Visit gemini.google.com; your brief loads automatically, no API key needed.',
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    subtitle: 'browser userscript',
    description: 'No MCP support — DeerDawn syncs context via a lightweight userscript.',
    userscriptTool: 'perplexity',
    setupSteps: [
      'Install a userscript manager (Tampermonkey or Violentmonkey).',
      'Click “Download userscript” below.',
      'Open the downloaded file — your manager will prompt to install it.',
      'Visit perplexity.ai; your brief loads automatically, no API key needed.',
    ],
  },
];

// What a given tool is actually handed, and what it does with it.
//
// This page used to render one thing for all nine cards: the bare remote MCP
// URL. For Claude.ai and ChatGPT.com that is right — it goes in a connector
// menu. For Claude Code and Codex it is a string with nothing to do: both
// register MCP servers through their own CLI and have no menu to paste a URL
// into. For Cursor and the desktop apps it is a config file.
//
// That mattered here more than anywhere else, because /setup is where the
// lifecycle emails land. They were repointed at this page (from /settings/tools,
// a redirect that stripped ?dd_email and made lifecycle_email_clicked read zero
// across 31 sends) specifically so the return path would work — and what the
// working link opened, for a CLI user, was a URL they could not act on.
//
// Every value comes from connectCopy, the same module /connect and the
// onboarding connect step render, so the three surfaces cannot tell a user three
// different stories. `via` mirrors REMOTE_SETUP_LOCATIONS.setupVia, which draws
// the same distinction on /connect.
type SetupArtifact = {
  via: 'terminal' | 'file' | 'browser';
  /**
   * Which artifact was taken, in the vocabulary the onboarding emitters already
   * use ('one_command' / 'manual' / 'url'), so a breakdown of mcp_config_copied
   * spans both pages instead of needing a mapping between two spellings.
   */
  copiedAs: 'one_command' | 'manual' | 'url';
  /** What to do with it, or where it goes. Never decoration. */
  label: string;
  code: string;
  /** Multi-line artifacts (configs, command pairs) must not be re-wrapped. */
  block?: boolean;
};

const SETUP_ARTIFACTS: Partial<Record<ToolId, SetupArtifact>> = {
  // `npx … setup` is Claude Code ONLY — runSetup never writes ~/.codex/config.toml,
  // so it must not be offered as the Codex path.
  'claude-code': { via: 'terminal', copiedAs: 'one_command', label: 'Run in your terminal', code: ONE_COMMAND_SETUP },
  codex: { via: 'terminal', copiedAs: 'one_command', label: 'Run in your terminal', code: CODEX_CLI_SETUP_CMDS, block: true },
  cursor: { via: 'file', copiedAs: 'manual', label: '.cursor/mcp.json (or ~/.cursor/mcp.json)', code: LOCAL_NPX_CONFIG_JSON, block: true },
  'claude-desktop': { via: 'file', copiedAs: 'manual', label: 'claude_desktop_config.json', code: LOCAL_NPX_CONFIG_JSON, block: true },
  'chatgpt-desktop': { via: 'file', copiedAs: 'manual', label: 'Your ChatGPT Desktop MCP config file', code: LOCAL_NPX_CONFIG_JSON, block: true },
  'claude-ai': { via: 'browser', copiedAs: 'url', label: 'Paste this URL into the connector form', code: REMOTE_MCP_URL },
  'chatgpt-com': { via: 'browser', copiedAs: 'url', label: 'Paste this URL into the connector form', code: REMOTE_MCP_URL },
  // gemini / perplexity install by userscript download and have no artifact.
};

interface ApiKey {
  key_id: string;
  name: string;
  prefix: string;
  environment: 'sandbox' | 'production';
  status: string;
  created_at: string;
  last_used_at: string | null;
}

type ToolState = 'live' | 'stale' | 'installed' | 'off';

// The artifact for one tool, with the thing it actually needs: a way to copy it.
// The old block had none at all — a terminal command you have to retype by hand
// is the second reason a CLI user could not act on this page.
function SetupArtifactPanel({ toolId }: { toolId: ToolId }) {
  const artifact = SETUP_ARTIFACTS[toolId];
  const [copied, setCopied] = useState(false);

  // Named fallback rather than an implied one. A tool with no entry is a tool we
  // have not thought about, and the remote URL is the only artifact that is at
  // least true for every MCP client — but say so, rather than presenting it as
  // this tool's instruction the way the old unconditional block did.
  const shown: SetupArtifact = artifact ?? {
    via: 'browser',
    copiedAs: 'url',
    label: 'Add a custom remote MCP server with this URL',
    code: REMOTE_MCP_URL,
  };

  const copyArtifact = async () => {
    // The clipboard can refuse: an insecure origin, a denied permission, an
    // embedded webview. Unhandled, that was a rejected promise in a click
    // handler — nothing copied, nothing said — and had it resolved late the
    // mcp_config_copied below would have counted a copy that never happened.
    try {
      await navigator.clipboard.writeText(shown.code);
    } catch {
      showToast('Could not copy. Select the text and copy it manually.', 'error');
      return;
    }
    setCopied(true);
    // Reset so a second copy still reads as one. The label is the only
    // confirmation on a card the user may sit on while configuring their tool.
    setTimeout(() => setCopied(false), 2000);
    showToast('Copied', 'success');
    trackProductEvent('mcp_config_copied', {
      source: 'dashboard',
      path: '/setup',
      metadata: { tool: toolId, via: shown.copiedAs, setup_via: shown.via, surface: 'setup_artifact' },
    });
  };

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border-subtle">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-[var(--code-bg)] px-2.5 py-1.5">
        {/* Not uppercased: half of these labels are file paths, and
            `.CURSOR/MCP.JSON` is not a path anyone can act on. */}
        <span className="font-mono text-[11px] text-text-muted">{shown.label}</span>
        <button
          onClick={copyArtifact}
          className="shrink-0 text-[11px] font-medium text-primary transition-colors hover:underline"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="m-0 max-h-48 overflow-auto bg-[var(--code-bg)] px-2.5 py-2 font-mono text-[11.5px] leading-5 text-text-primary">
        <code className={shown.block ? 'whitespace-pre' : 'whitespace-pre-wrap break-all'}>{shown.code}</code>
      </pre>
    </div>
  );
}

/**
 * WHICH WORKSPACE IS THIS KEY FOR?
 *
 * An API key is a WORKSPACE credential: it is minted against the workspace the
 * request was bound to, and everything the agent holding it writes lands there.
 * The panel that mints them said nothing about which one, so somebody who had
 * just joined a team could create a key, wire it into their repo, and file a
 * month of work in their personal workspace without a single screen disagreeing
 * with them.
 *
 * For a team it also shows the committable .mcp.json, because that is the answer
 * to the question the key raises: a local tool points at the team by carrying
 * the workspace in its config, not by being reinstalled.
 *
 * AND IT IS THE BOUND WORKSPACE, NOT THE ONE ANSWERING READS. This panel used to
 * ask `servedWorkspace`, which is the right question for the projects and briefs
 * around it and the wrong one for a credential: POST /api/v1/keys is exempt from
 * plan enforcement, so the fallback never rebinds it and the key is minted
 * against the lapsed team while the sentence promised the reader's own
 * workspace. That key is dead until somebody pays, and alive in the TEAM
 * afterwards, where a new project defaults to `shared`.
 */
function WorkspaceKeyScope({ scope, config, switching, acknowledged, onUseOwnWorkspace, onMintAnyway }: {
  scope: CredentialWorkspace;
  config: WorkspaceConfig | null;
  switching: boolean;
  /** They have said to mint into the lapsed workspace anyway. */
  acknowledged: boolean;
  onUseOwnWorkspace: () => void;
  onMintAnyway: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(file: { path: string; contents: string }) {
    try {
      await navigator.clipboard.writeText(file.contents);
      setCopied(file.path);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      showToast('Could not copy. Select the text and copy it manually.', 'error');
    }
  }

  const { name, personal, inactive } = scope;

  // THE WORKSPACE A KEY WOULD BELONG TO IS NOT SERVING. Say what minting now
  // would actually produce, and make the way out the primary action: switching
  // is what makes the ordinary sentence true again. Minting into the lapsed
  // workspace stays reachable for its owner, who may be about to pay for it.
  if (inactive) {
    const canMintAnyway = scope.role === 'owner';
    return (
      <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
        <p className="text-[13px] leading-6 text-text-primary">
          {credentialWorkspaceWarning(inactive)}
        </p>
        <p className="mt-2 text-[12.5px] leading-6 text-text-muted">
          {acknowledged
            ? `The key below will belong to ${name || 'that workspace'}. It starts working when that workspace does.`
            : 'Your projects and briefs on this page are already coming from your own workspace. A key created there works now, and everything an agent writes with it lands beside the work you can see.'}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button size="sm" variant={acknowledged ? 'secondary' : 'primary'} disabled={switching} onClick={onUseOwnWorkspace}>
            {switching ? 'Switching…' : 'Use my own workspace'}
          </Button>
          {canMintAnyway && !acknowledged ? (
            <button
              type="button"
              onClick={onMintAnyway}
              className="text-[12px] font-medium text-text-muted transition-colors hover:text-text-primary"
            >
              {name ? `Create it for ${name} anyway` : 'Create it for that workspace anyway'}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-4">
      <p className="text-[13px] leading-6 text-text-primary">
        {keyWorkspaceSentence(scope)}
      </p>

      {!personal && config?.files?.length ? (
        <>
          <p className="mt-2 text-[12.5px] leading-6 text-text-muted">
            To point a repo&rsquo;s local tool at {name || 'this workspace'}, commit this instead of giving people a
            key. It names the workspace and contains no credential, and each person signs in as themselves the first
            time their agent uses it.
          </p>
          {config.files.map((file) => (
            <div key={file.path} className="mt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <code className="text-[11.5px] text-text-primary">{file.path}</code>
                <button
                  onClick={() => void copy(file)}
                  className="shrink-0 text-[11px] font-medium text-primary transition-colors hover:underline"
                >
                  {copied === file.path ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-md border border-border-subtle bg-[var(--code-bg)] p-3 font-mono text-[11.5px] leading-5 text-text-secondary">
                {file.contents.trimEnd()}
              </pre>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

// Setup — connect your tools and issue credentials. Two sections, one page,
// because they are the same job on the same twice-a-year schedule.
//
// A connected tool is one row: name, state, last seen. The old page rendered all
// nine as equal-weight cards with their full setup instructions inline, forever
// — including for the six you don't use. Instructions now appear only for the
// tool you're actually connecting.
export default function SetupPage() {
  const confirm = useConfirm();

  const [selfAttested, setSelfAttested] = useState<Record<ToolId, boolean>>(() =>
    Object.fromEntries(AI_TOOLS.map((t) => [t.id, false])) as Record<ToolId, boolean>,
  );
  const [usageSurfaces, setUsageSurfaces] = useState<McpSurfaceUsage[]>([]);
  // The apps holding an OAuth credential for this person. Null until the read
  // lands, and left null if it fails: the rows then read exactly as before.
  const [connections, setConnections] = useState<HostedConnection[] | null>(null);
  // Which row's disconnect is in flight, keyed by card id or connection id.
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [openTool, setOpenTool] = useState<ToolId | null>(null);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'connected' | 'not_found'>('idle');
  const [dlStatus, setDlStatus] = useState<'idle' | 'downloading' | 'error'>('idle');

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEnv, setNewEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [newKeySecret, setNewKeySecret] = useState<string | null>(null);
  // What the server granted the key just minted, when it says. A viewer's
  // default key is narrowed to read-only, and the panel has to say so.
  const [newKeyScopes, setNewKeyScopes] = useState<string[] | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  // The workspace a key minted here would BELONG to. Not the one serving this
  // page's reads: POST /api/v1/keys is exempt from plan enforcement, so a
  // fallback never rebinds it and the two answers come apart exactly when it
  // matters most.
  const [keyWorkspace, setKeyWorkspace] = useState<CredentialWorkspace | null>(null);
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(null);
  // Pressed "Create it for <Team> anyway". Deliberately not persisted: it is a
  // decision about the key being made right now, not a preference.
  const [mintAnyway, setMintAnyway] = useState(false);
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);

  useEffect(() => {
    setSelfAttested(
      Object.fromEntries(AI_TOOLS.map((t) => [t.id, getConnected(t.id)])) as Record<ToolId, boolean>,
    );
    trackProductEvent('mcp_setup_viewed', {
      source: 'dashboard',
      path: '/setup',
      metadata: { surface: 'setup' },
    });
  }, []);

  useEffect(() => {
    api
      .getDashboardBootstrap()
      .then((boot) => setUsageSurfaces(usageFromHealth(boot.sync_health)))
      .catch(() => {});
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await api.getHostedConnections());
    } catch (err) {
      logger.error('hosted_connections_load_failed', err);
    }
  }, []);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      setKeys(await api.getKeys());
    } catch (err) {
      logger.error('api_keys_load_failed', err);
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  // Additive, and silent when either read fails: the keys panel worked without
  // this before and still has to.
  useEffect(() => {
    let cancelled = false;
    const apply = (res: WorkspacesListing) => {
      if (cancelled) return;
      // What the key would BELONG to, which is the stored choice: the keys
      // route is exempt from plan enforcement and therefore never rebound by
      // a fallback. Naming what is serving instead promised the reader their
      // own workspace and handed them the team's credential. And the stored
      // choice is THIS BROWSER's (the header POST /keys carries), not the
      // listing's `active`, which is the server's and may be another device's.
      const scope = credentialWorkspace(res, getWorkspaceFallbackKey(), getActiveWorkspace());
      if (!scope.workspace) return;
      setKeyWorkspace(scope);
      if (scope.personal) return;
      // Only a team has a repo-committable config worth showing, and the
      // route is feature-gated, so a failure here is ordinary.
      api.getWorkspaceConfig()
        .then((cfg) => { if (!cancelled) setWorkspaceConfig(cfg); })
        .catch(() => { /* the key scope line is still worth showing on its own */ });
    };
    api.getWorkspaces()
      .then(apply)
      .catch(() => { /* no listing: the panel reads exactly as it did before */ });
    // The shell re-reads the listing when a fallback may have ended. This panel
    // is the one that hands out a credential, so it must not be the last screen
    // still describing a workspace that started answering again.
    const unsubscribe = onWorkspaceListing(apply);
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  // Minting is held only while the workspace the key would belong to is the one
  // that is not answering, and only until the person says which they meant. It
  // is not a lock: "Create it for <Team> anyway" is right there for its owner.
  const mintBlocked = Boolean(keyWorkspace?.inactive) && !mintAnyway;

  const mintKeysInOwnWorkspace = useCallback(async () => {
    setSwitchingWorkspace(true);
    if (!(await switchToPersonalWorkspace())) {
      // A reload would mint into the workspace being left: the server still has
      // it active and this browser now sends no header to override that.
      setSwitchingWorkspace(false);
      showToast(PERSONAL_SWITCH_FAILED_MESSAGE, 'error');
      return;
    }
    // A full reload, not a state update: the keys already listed, the workspace
    // config and every other read on this page were scoped to the workspace
    // being left, and a half-swapped page is how the wrong one gets trusted.
    window.location.reload();
  }, []);

  // Real per-tool call data, keyed by card id — the truthful signal, vs. the
  // self-attested localStorage flag that can't be trusted across devices.
  const usageByTool = useMemo(() => usageByToolId(usageSurfaces), [usageSurfaces]);

  const placedConnections = useMemo(
    () => connectionsByTool(connections ?? []),
    [connections],
  );

  const rows = useMemo(() => {
    return AI_TOOLS.map((tool) => {
      const usage = usageByTool.get(tool.id);
      const { days, state } = toolRowState({ toolId: tool.id, usage, selfAttested: selfAttested[tool.id], connections });
      return { tool, usage, days, state, held: placedConnections.byTool.get(tool.id) ?? [] };
    }).sort((a, b) => {
      const rank: Record<ToolState, number> = { live: 0, stale: 1, installed: 2, off: 3 };
      if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
      return (a.days ?? 1e9) - (b.days ?? 1e9);
    });
  }, [usageByTool, selfAttested, connections, placedConnections]);

  const connectedCount = rows.filter((r) => r.state !== 'off').length;

  async function handleTestConnection() {
    setTestStatus('testing');
    try {
      const boot = await api.getDashboardBootstrap();
      setUsageSurfaces(usageFromHealth(boot.sync_health));
      // "Test connection" has to test the connection. `has_projects` used to be
      // ORed in here, so this button answered yes for anyone who had ever saved
      // a brief from the dashboard itself — including the onboarding capture
      // step's two inline fields, which run before any tool is connected on the
      // phone ordering. Same definition as the connect step, from the same
      // module, and `evidence` names which signal answered.
      const evidence = connectionEvidence({
        mcpRegistered: Boolean(boot.sync_health?.mcp_registered),
        hasFirstSync: Boolean(boot.sync_health?.has_first_sync),
        hasProjects: Boolean(boot.sync_health?.has_projects),
        recentlyActive: Boolean(boot.sync_health?.recently_active),
      });
      const detected = evidence !== 'none';
      setTestStatus(detected ? 'connected' : 'not_found');
      trackProductEvent('mcp_connection_tested', {
        source: 'dashboard',
        path: '/setup',
        metadata: { detected, evidence },
      });
    } catch {
      setTestStatus('not_found');
    }
  }

  async function handleDownloadUserscript(tool: WebCaptureTool) {
    setDlStatus('downloading');
    try {
      await api.downloadUserscript(tool);
      setDlStatus('idle');
    } catch {
      setDlStatus('error');
    }
  }

  const resetForm = () => {
    setIsCreating(false);
    setNewName('');
    setNewEnv('sandbox');
    setNewKeySecret(null);
    setNewKeyScopes(null);
    setShowSecret(false);
    setIsCopied(false);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const usedDefaultName = !newName;
    const create = async (name: string) => {
      const res = await api.createKey(name, newEnv);
      setNewKeySecret(res.key.key);
      setNewKeyScopes(grantedKeyScopes(res));
      setShowSecret(true);
      loadKeys();
      showToast('API key created', 'success');
    };
    try {
      await create(newName || DEFAULT_KEY_NAME);
    } catch (err) {
      logger.error('api_key_create_failed', err);
      const failure = isApiError(err)
        ? { status: err.status, data: err.data, message: err.message }
        : { message: err instanceof Error ? err.message : '' };
      // A second unnamed key collided on the name this page chose, not on
      // anything the person did — they left the field alone twice. Pick another
      // default rather than stopping a new account at the step everything else
      // depends on. Once only: a second conflict means something renaming will
      // not fix.
      if (shouldRetryWithNewName(failure, usedDefaultName)) {
        try {
          await create(nextDefaultKeyName(1));
          return;
        } catch (retryErr) {
          logger.error('api_key_create_retry_failed', retryErr);
          showToast(
            describeKeyCreateFailure(
              isApiError(retryErr)
                ? { status: retryErr.status, data: retryErr.data, message: retryErr.message }
                : {},
            ),
            'error',
          );
          return;
        }
      }
      showToast(describeKeyCreateFailure(failure), 'error');
    }
  };

  const handleRevoke = async (id: string) => {
    if (
      !(await confirm({
        title: 'Revoke this API key?',
        body: 'Any integration still using this key will immediately stop working. This cannot be undone.',
        confirmLabel: 'Revoke key',
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await api.deleteKey(id);
      showToast('Key revoked', 'success');
      loadKeys();
    } catch (err) {
      const failure = describeKeyRevokeFailure(isApiError(err) ? err : {});
      if (failure.alreadyGone) {
        showToast(failure.message, 'success');
        loadKeys();
        return;
      }
      showToast(failure.message, 'error');
    }
  };

  // Take an app's access away: the same confirm-then-act as handleRevoke above,
  // because it is the same kind of act. `targets` is every connection that app
  // holds (a tool re-added from scratch registers again, so one tool can be
  // two). The rows read `connections`, so they change the moment a disconnect
  // lands, and the server's own listing is read again after it.
  const handleDisconnect = async (name: string | null, rowKey: string, targets: HostedConnection[]) => {
    const subject = name ?? 'This app';
    if (
      !(await confirm({
        title: name ? `Disconnect ${name}?` : 'Disconnect this app?',
        body: `${subject} will lose access to your DeerDawn memory right away: its current token stops working and it cannot renew it.${targets.length > 1 ? ` This removes all ${targets.length} of its connections.` : ''} Your projects and briefs are not deleted. To use DeerDawn there again, reconnect it from ${name ?? 'the app'}.`,
        confirmLabel: 'Disconnect',
        destructive: true,
      }))
    ) {
      return;
    }
    setDisconnecting(rowKey);
    const gone: string[] = [];
    let failure: string | null = null;
    for (const target of targets) {
      try {
        await api.disconnectHostedConnection(target.connection_id);
        gone.push(target.connection_id);
      } catch (err) {
        const described = describeDisconnectFailure(isApiError(err) ? err : {});
        if (described.alreadyGone) {
          gone.push(target.connection_id);
          continue;
        }
        failure = described.message;
        break;
      }
    }
    setConnections((current) => (current ? current.filter((c) => !gone.includes(c.connection_id)) : current));
    setDisconnecting(null);
    if (failure) showToast(failure, 'error');
    else showToast(`${subject} disconnected`, 'success');
    loadConnections();
  };

  const openToolMeta = AI_TOOLS.find((t) => t.id === openTool) || null;

  return (
    <>
      <Head><title>Setup | DeerDawn</title></Head>

      <div className="flex min-h-0 flex-1 flex-col gap-8">
        {/* ── Tools ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="dashboard-title">Setup</h1>
            <span className="text-[13px] text-text-muted">
              {connectedCount} of {AI_TOOLS.length} tools connected
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="secondary" onClick={handleTestConnection} disabled={testStatus === 'testing'}>
                {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
              </Button>
              <a
                href={`${MARKETING_URL}/connect`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] font-medium text-primary hover:underline"
              >
                Setup guide →
              </a>
            </div>
          </div>

          {testStatus === 'connected' && (
            <p className="text-[13px] font-medium text-primary">DeerDawn detected an active MCP connection.</p>
          )}
          {testStatus === 'not_found' && (
            <p className="text-[13px] text-text-secondary">
              No connection yet — restart your tool, finish the browser sign-in, then test again.
            </p>
          )}

          <div className="flex flex-col">
            <div className="flex items-center gap-4 pb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-muted">
              <span className="flex-1">Tool</span>
              <span className="w-32 max-sm:hidden">Last seen</span>
              <span className="w-[7rem] text-right">&nbsp;</span>
            </div>

            {rows.map(({ tool, usage, days, state, held }) => (
              <div key={tool.id} className="border-t border-border-subtle last:border-b">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 py-3">
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      state === 'live'
                        ? 'bg-primary'
                        : state === 'stale'
                          ? 'bg-status-warning'
                          : state === 'installed'
                            ? 'bg-border-strong'
                            : 'bg-border-strong'
                    }`}
                  />
                  <span className="min-w-[12rem] flex-1">
                    <span
                      className={`text-[13.5px] font-semibold ${state === 'off' ? 'text-text-muted' : 'text-text-primary'}`}
                    >
                      {tool.name}
                    </span>
                    <span className="text-[12.5px] text-text-muted"> · {tool.subtitle}</span>
                    {state === 'stale' && (
                      <span className="block text-[12px] text-status-warning">
                        connected, but hasn&apos;t loaded context in {days} days
                      </span>
                    )}
                    {(state === 'live' || state === 'stale') && usage?.transports && usage.transports.length > 0 && (
                      <span className="block text-[12px] text-text-muted">
                        via {usage.transports.map(transportLabel).join(', ')}
                      </span>
                    )}
                    {state === 'installed' && (
                      <span className="block text-[12px] text-text-muted">
                        marked installed on this browser — no calls seen yet
                      </span>
                    )}
                    {held.length > 0 && state === 'off' && (
                      <span className="block text-[12px] text-text-muted">
                        authorized, no calls yet
                      </span>
                    )}
                  </span>

                  <span className="w-32 shrink-0 font-mono text-[11.5px] text-text-muted max-sm:hidden">
                    {relativeDays(days)}
                    {usage && usage.start_sessions > 0 ? ` · ${usage.start_sessions} loads` : ''}
                  </span>

                  {/* Wide enough for "Disconnect" (the old w-24 was narrower than
                      the button), and a min-width rather than a width so
                      "Disconnecting…" grows the slot instead of overflowing it. */}
                  <span className="flex min-w-[7rem] shrink-0 justify-end gap-1">
                    {held.length > 0 ? (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={disconnecting === tool.id}
                        onClick={() => void handleDisconnect(tool.name, tool.id, held)}
                      >
                        {disconnecting === tool.id ? 'Disconnecting…' : 'Disconnect'}
                      </Button>
                    ) : state === 'live' ? (
                      <button
                        onClick={() => {
                          setConnectedFlag(tool.id, false);
                          setSelfAttested((p) => ({ ...p, [tool.id]: false }));
                        }}
                        className="text-[11px] text-text-muted underline underline-offset-2 transition-colors hover:text-text-secondary"
                      >
                        reset
                      </button>
                    ) : (
                      <Button
                        size="sm"
                        variant={state === 'stale' ? 'secondary' : 'ghost'}
                        onClick={() => setOpenTool(openTool === tool.id ? null : tool.id)}
                      >
                        {state === 'stale' ? 'Fix' : openTool === tool.id ? 'Close' : 'Connect'}
                      </Button>
                    )}
                  </span>
                </div>

                {/* Setup instructions render for the ONE tool being connected. */}
                {openTool === tool.id && openToolMeta && (
                  <div className="mb-3 rounded-xl border border-border-subtle bg-overlay-subtle p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <h2 className="text-[13px] font-semibold text-text-primary">Connect {tool.name}</h2>
                      {/* Only when /connect really has a section for this card.
                          The href was `/connect#${tool.id}` for all nine cards
                          while the page defined four of those ids, so most of
                          these links opened the top of a long page. */}
                      {connectGuideAnchor(tool.id) && (
                        <Link
                          href={`${MARKETING_URL}/connect${connectGuideAnchor(tool.id)}`}
                          className="ml-auto text-[12px] font-medium text-primary hover:underline"
                        >
                          Full guide
                        </Link>
                      )}
                    </div>

                    <p className="mt-2 text-[12.5px] leading-6 text-text-secondary">{tool.description}</p>

                    {tool.userscriptTool ? (
                      <div className="mt-3">
                        <Button
                          size="sm"
                          onClick={() => handleDownloadUserscript(tool.userscriptTool as WebCaptureTool)}
                          disabled={dlStatus === 'downloading'}
                        >
                          {dlStatus === 'downloading' ? 'Downloading…' : 'Download userscript'}
                        </Button>
                        {dlStatus === 'error' && (
                          <p className="mt-2 text-[12px] text-status-danger">
                            Couldn&apos;t fetch the userscript. Make sure you&apos;re signed in, then try again.
                          </p>
                        )}
                      </div>
                    ) : (
                      <SetupArtifactPanel toolId={tool.id} />
                    )}

                    {tool.setupSteps && (
                      <ol className="mt-3 space-y-1.5 text-[12.5px] leading-5 text-text-secondary">
                        {tool.setupSteps.map((step, i) => (
                          <li key={step} className="flex gap-2.5">
                            <span className="shrink-0 font-mono text-[11px] text-text-muted">{i + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    )}

                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" onClick={handleTestConnection} disabled={testStatus === 'testing'}>
                        {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setConnectedFlag(tool.id, true);
                          setSelfAttested((p) => ({ ...p, [tool.id]: true }));
                          setOpenTool(null);
                        }}
                      >
                        I installed it
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Apps holding a credential that no card above can claim by name:
              an editor Setup has no card for, or a connection made before its
              client's name was recorded. Listed so nothing with access to the
              memory is out of reach of Disconnect. */}
          {placedConnections.other.length > 0 && (
            <div className="flex flex-col">
              <div className="pb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-text-muted">
                Other connected apps
              </div>
              {placedConnections.other.map((connection) => {
                const label = connection.client_name || 'Unnamed app';
                return (
                  <div
                    key={connection.connection_id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border-subtle py-3 last:border-b"
                  >
                    <span className="min-w-[12rem] flex-1">
                      <span className="text-[13.5px] font-semibold text-text-primary">{label}</span>
                      <span className="text-[12.5px] text-text-muted"> · {endpointPath(connection.resource)}</span>
                      <span className="block text-[12px] text-text-muted">
                        authorized {new Date(connection.first_authorized_at).toLocaleDateString()}
                        {' · last used '}
                        {connection.last_used_at ? relativeDays(daysSince(connection.last_used_at)) : 'never'}
                      </span>
                    </span>
                    <span className="flex min-w-[7rem] shrink-0 justify-end gap-1">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={disconnecting === connection.connection_id}
                        onClick={() => void handleDisconnect(connection.client_name, connection.connection_id, [connection])}
                      >
                        {disconnecting === connection.connection_id ? 'Disconnecting…' : 'Disconnect'}
                      </Button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <SecondToolNudge />
        </section>

        {/* ── API keys ──────────────────────────────────────────────────── */}
        <section id="keys" className="flex flex-col gap-3 scroll-mt-6">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold tracking-[-0.02em] text-text-primary">API keys</h2>
            <span className="text-[13px] text-text-muted">
              For a backend or agent that authenticates with a header instead of OAuth.
            </span>
            {!isCreating && !mintBlocked && (
              <Button size="sm" className="ml-auto" onClick={() => setIsCreating(true)}>
                New key
              </Button>
            )}
          </div>

          {keyWorkspace && (
            <WorkspaceKeyScope
              scope={keyWorkspace}
              config={workspaceConfig}
              switching={switchingWorkspace}
              acknowledged={mintAnyway}
              onUseOwnWorkspace={() => void mintKeysInOwnWorkspace()}
              onMintAnyway={() => { setMintAnyway(true); setIsCreating(true); }}
            />
          )}

          {isCreating && !mintBlocked && (
            <div className="rounded-xl border border-border-subtle bg-overlay-subtle p-5">
              <h3 className="text-[13px] font-semibold text-text-primary">
                {newKeySecret ? 'Copy the key now' : 'Create a new key'}
              </h3>

              {!newKeySecret ? (
                <form onSubmit={handleCreateSubmit} className="mt-3 grid gap-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="grid gap-2">
                      <span className="dashboard-eyebrow">Key name</span>
                      <input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="Production backend"
                        className="dashboard-input"
                      />
                    </label>
                    <label className="grid gap-2">
                      <span className="dashboard-eyebrow">Environment</span>
                      <select
                        value={newEnv}
                        onChange={(e) => setNewEnv(e.target.value as 'sandbox' | 'production')}
                        className="dashboard-select"
                      >
                        <option value="sandbox">Sandbox</option>
                        <option value="production">Production</option>
                      </select>
                    </label>
                  </div>
                  <p className="text-[12.5px] leading-6 text-text-muted">
                    Name keys by workload, not by person, so ownership is obvious during incidents. Revoke a key
                    as soon as the service that owned it is retired.
                  </p>
                  <div className="flex gap-3">
                    <Button type="submit" size="sm">Create key</Button>
                    <Button type="button" size="sm" variant="secondary" onClick={resetForm}>Cancel</Button>
                  </div>
                </form>
              ) : (
                <div className="mt-3 space-y-3">
                  <p className="rounded-lg border border-status-warning/25 bg-[var(--status-escalate-bg)] px-4 py-3 text-[13px] text-text-secondary">
                    This secret will not be shown again. Copy it now and store it in your environment manager.
                  </p>
                  {mintedKeyAccessNote(newKeyScopes, keyWorkspace?.name ?? null) ? (
                    <p className="text-[12.5px] leading-6 text-text-secondary">
                      {mintedKeyAccessNote(newKeyScopes, keyWorkspace?.name ?? null)}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-[var(--code-bg)] px-4 py-3">
                    <span className="flex-1 break-all font-mono text-[12.5px] text-primary">
                      {showSecret ? newKeySecret : '•'.repeat(48)}
                    </span>
                    <div className="flex gap-2">
                      <Tooltip content={showSecret ? 'Hide secret' : 'Show secret'}>
                        <button
                          onClick={() => setShowSecret(!showSecret)}
                          aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                          className="rounded-full border border-border-subtle p-2 text-text-muted transition-colors hover:border-border-strong hover:text-text-primary"
                        >
                          {showSecret ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      </Tooltip>
                      <Button
                        size="sm"
                        onClick={async () => {
                          if (!newKeySecret) return;
                          try {
                            await navigator.clipboard.writeText(newKeySecret);
                          } catch {
                            showToast('Could not copy. Select the key and copy it manually.', 'error');
                            return;
                          }
                          setIsCopied(true);
                          showToast('Copied', 'success');
                        }}
                      >
                        {isCopied ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={resetForm}>Done</Button>
                </div>
              )}
            </div>
          )}

          {keysLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg border border-border-subtle bg-overlay-subtle" />
              ))}
            </div>
          ) : keys.length === 0 ? (
            <p className="border-t border-border-subtle py-8 text-center text-sm text-text-muted">
              No API keys yet. Most tools connect over MCP and never need one.
            </p>
          ) : (
            <DashboardTableWrap>
              <table className="dashboard-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Prefix</th>
                    <th>Environment</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.key_id}>
                      <td className="text-sm font-medium text-text-primary">
                        {key.name}
                        {key.last_used_at ? (
                          <span className="ml-2 text-[11px] font-semibold text-primary">· active</span>
                        ) : (
                          <span className="ml-2 text-[11px] text-text-muted">· never used</span>
                        )}
                      </td>
                      <td className="font-mono text-xs text-text-secondary">{key.prefix}••••</td>
                      <td className="text-sm text-text-secondary">{key.environment}</td>
                      <td className="text-sm text-text-muted">{new Date(key.created_at).toLocaleDateString()}</td>
                      <td className="text-sm text-text-muted">
                        {key.last_used_at ? relativeDays(daysSince(key.last_used_at)) : 'never'}
                      </td>
                      <td className="text-right">
                        <Button size="sm" variant="danger" onClick={() => handleRevoke(key.key_id)}>
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DashboardTableWrap>
          )}
        </section>

        {/* ── Demoted detail ───────────────────────────────────────────── */}
        <div className="flex flex-col">
          {usageSurfaces.length > 0 && (
            <DisclosureRow label="DeerDawn usage by tool" meta="last 30 days">
              <ul className="space-y-2">
                {usageSurfaces
                  .slice()
                  .sort((a, b) => b.tool_calls - a.tool_calls)
                  .map((s) => (
                    <li key={s.surface} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px]">
                      <span className="min-w-[8rem] font-medium text-text-primary">
                        {surfaceLabel(s.surface)}
                        {s.transports && s.transports.length > 0 && (
                          <span className="ml-1.5 font-normal text-text-muted">({s.transports.map(transportLabel).join(', ')})</span>
                        )}
                      </span>
                      <span className="text-text-secondary">
                        {s.start_sessions} session load{s.start_sessions === 1 ? '' : 's'}
                        {s.call_rate !== null ? ` (${s.call_rate}% of starts)` : ''} · {s.update_contexts} write-back
                        {s.update_contexts === 1 ? '' : 's'}
                      </span>
                      <span className="text-text-muted">{relativeDays(daysSince(s.last_called_at))}</span>
                    </li>
                  ))}
              </ul>
            </DisclosureRow>
          )}

          <DisclosureRow label="Troubleshooting" meta="tool not showing up? five things to check">
            <ol className="space-y-1.5 text-[12.5px] leading-5 text-text-secondary">
              {TROUBLESHOOTING_STEPS.map((step, i) => (
                <li key={step} className="flex gap-2.5">
                  <span className="shrink-0 font-mono text-[11px] text-text-muted">{i + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[12.5px] text-text-muted">
              Still stuck? Email{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary hover:underline">{SUPPORT_EMAIL}</a> and a
              human will help.
            </p>
          </DisclosureRow>
        </div>
      </div>
    </>
  );
}
