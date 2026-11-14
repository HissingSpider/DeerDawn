import { useState, useEffect, useRef, Fragment } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { api, isApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { markOnboardingStart, trackProductEvent, trackOnboardingCompletion } from '@/lib/productAnalytics';
import { phCapture } from '@/lib/posthog';
import { isRealReturn } from '@/lib/connectReturn';
import {
  connectionEvidence,
  connectionStatus,
  nextPollDelay,
  type ConnectionEvidence,
  type ConnectionSignals,
} from '@/lib/connectionEvidence';
import { useAuthPresence } from '@/components/layout/AuthProvider';
import { useIsMobile, isMobileNow, useStepDiagnostics, usePageScroll } from '@/hooks';
import {
  PREVIEW_LOCATIONS,
  PREVIEW_SETUP,
  PREVIEW_SIGNIN_ROUTE,
  PREVIEW_SIGNUP_ROUTE,
  WHAT_SIGNING_IN_ADDS,
} from '@/lib/onboardingPreview';
import {
  REMOTE_MCP_URL,
  AGENT_SETUP_PROMPT,
  ONE_COMMAND_SETUP,
  CODEX_CLI_SETUP_CMDS,
  CLAUDE_CODE_REMOTE_CMD,
  CLAUDE_CODE_LOCAL_CMD,
  LOCAL_NPX_CONFIG_JSON,
  CODEX_TOML_CONFIG,
  ADVANCED_LOCAL_BULLETS,
  REMOTE_SETUP_LOCATIONS,
  CLAUDE_AI_SYSTEM_PROMPT,
  AUTOMATION_SETUP,
  DEFAULT_AUTOMATION_SETUP,
  CONNECTOR_MENU_PATHS,
} from '@/lib/connectCopy';
import { SELF_HOSTED_API_URL } from '@/lib/connectTarget';

// A brand-new user has NOTHING saved yet, so "run start_session and tell me what
// I was working on" comes back empty — a dead first move. The first session is
// the one that WRITES the brief, so this prompt seeds it: the tool asks what
// they're building and saves it as their first brief.
const FIRST_BRIEF_PROMPT = "I just connected DeerDawn. Ask me what I'm working on and the key decisions so far, then save it with manage_memory (action 'update') as my project brief.";

// Phone-completable tools: their connector settings can be reached straight from
// a mobile browser, so we surface a one-tap deep link to the exact page.
//
// Claude ONLY. ChatGPT was listed here too, but its custom-MCP path is behind
// Developer Mode, which is web-first, still beta, and gated to Plus/Pro/Business
// — so a phone user who picked ChatGPT was sent to a page where they could not
// finish. That claim mattered: 16 of the 21 real signups who reached onboarding
// (2026-06-21..08-05) were on mobile, 5 copied a config, and ZERO ever completed
// a connection. Claude's custom connectors do work on the mobile apps, including
// on the free plan (limit: one custom connector).
const PHONE_DEEP_LINKS: Record<string, { url: string; label: string }> = {
  'Claude.ai': { url: 'https://claude.ai/settings/connectors', label: 'Open Claude' },
};

// The tool a phone user is steered to by default, since it is the only one they
// can actually finish without a computer.
const PHONE_PRIMARY_TOOL = 'Claude.ai';

// ── Command-first setup for the CLI tools ────────────────────────────────────
// The measured leak this exists to close: of the 11 people who copied an MCP
// config in the 14 days to 2026-08-19, 8 never connected. The copy path asks the
// user to find the right file, paste into it, and restart the tool — three steps
// they can silently get wrong, and no signal when they do. A command they paste
// into a terminal has none of those failure modes, so for the tools that have one
// it is the default-visible path and the hand-edited config is demoted to a
// disclosure.
//
// `does` is the honest inventory of what the command performs — the point is to
// remove steps, not to hide them.
type CliSetup = {
  heading: string;
  copyLabel: string;
  command: string;
  does: string[];
  verify: string;
  // What the user must do AFTER the command finishes. Neither CLI boots the
  // server itself, so without this the page's "we'll notice by itself" is a
  // promise it cannot keep.
  then: string;
  // Same tool, done by hand. Kept reachable (a command can fail — `claude mcp
  // add` shelling out is best-effort) but never the first thing on screen.
  manual: { label: string; command: string; filePath: string; authorize?: string };
};

const CLI_SETUP: Record<string, CliSetup> = {
  'Claude Code': {
    heading: 'Run this one command in your terminal',
    copyLabel: 'Copy setup command',
    command: ONE_COMMAND_SETUP,
    does: [
      'Opens your browser to sign in — there is no API key to create.',
      'Registers the DeerDawn MCP server with Claude Code.',
      'Installs the SessionStart/Stop capture hooks and updates ~/.claude/CLAUDE.md.',
    ],
    verify: 'claude mcp list',
    then: 'Restart Claude Code when it finishes — it launches the DeerDawn server at startup.',
    manual: {
      label: 'Register the hosted server yourself',
      authorize: 'Then run /mcp in Claude Code and authorize — a DeerDawn tab opens for sign-in.',
      command: CLAUDE_CODE_REMOTE_CMD,
      filePath: 'Run in your terminal',
    },
  },
  // Codex gets its OWN CLI, not `npx … setup`: runSetup registers the server with
  // Claude Code only, and would leave a Codex user with a sign-in and no server.
  Codex: {
    heading: 'Run these two commands in your terminal',
    copyLabel: 'Copy setup commands',
    command: CODEX_CLI_SETUP_CMDS,
    does: [
      'Registers DeerDawn’s hosted server with Codex — nothing runs on your machine.',
      'Opens your browser to sign in and authorize it.',
    ],
    verify: 'codex mcp get deerdawn --json',
    then: 'Restart Codex if the DeerDawn tools are not visible yet.',
    manual: {
      label: 'Edit ~/.codex/config.toml yourself',
      command: CODEX_TOML_CONFIG,
      filePath: '~/.codex/config.toml',
    },
  },
};

// ── No-install fallback timing ──────────────────────────────────────────────
// How long the connect step waits before offering the hosted (remote MCP + OAuth)
// path. Nothing is offered before this: an alternative that appears while someone
// is still working through the steps competes with the path they just chose, and
// reads as a nag. After three minutes with no check-in, "nothing has arrived yet"
// is a true statement and the hosted path — which has no local config to get
// wrong — is the useful thing to say.
const CONNECTION_TIMEOUT_MS = 3 * 60 * 1000;

// The tool the fallback routes to. Claude.ai's custom connectors are the hosted
// path we can actually promise: one URL, browser sign-in, nothing installed.
const NO_INSTALL_TOOL = 'Claude.ai';

// Tools that are ALREADY the no-install path — offering it to them is nonsense.
const NO_INSTALL_TOOLS = new Set([NO_INSTALL_TOOL, 'ChatGPT.com']);

type ToolTab = 'claude' | 'cursor' | 'codex';

const ADVANCED_TABS: { id: ToolTab; label: string; filePath: string }[] = [
  // Claude Code does NOT read ~/.claude/mcp.json — it registers MCP servers via the
  // `claude mcp add` CLI, so this tab shows a terminal command, not a file.
  { id: 'claude', label: 'Claude Code', filePath: 'Run in your terminal' },
  { id: 'cursor', label: 'Cursor', filePath: '~/.cursor/mcp.json' },
  { id: 'codex', label: 'Codex', filePath: '~/.codex/config.toml' },
];

function buildAdvancedConfig(tool: ToolTab): string {
  if (tool === 'claude') return CLAUDE_CODE_LOCAL_CMD;
  if (tool === 'codex') return CODEX_TOML_CONFIG;
  return LOCAL_NPX_CONFIG_JSON;
}

function CopyButton({ text, label = 'Copy', onCopy, prominent = false }: { text: string; label?: string; onCopy?: () => void; prominent?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); onCopy?.(); })}
      className={`ui-press ui-focus inline-flex items-center justify-center gap-1 border font-semibold transition-colors ${prominent ? 'min-h-11 rounded-xl border-primary/40 bg-primary px-5 py-2.5 text-sm text-on-primary hover:bg-primary/90' : 'rounded-md px-2.5 py-1 text-[11px]'} ${
        copied
          ? prominent ? 'border-primary/40 bg-primary/80 text-on-primary' : 'border-primary/30 bg-primary/15 text-primary'
          : prominent ? '' : 'border-border-subtle bg-overlay-active text-text-secondary hover:text-text-primary'
      }`}
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

function StepRow({ num, children }: { num: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-[11px] font-bold text-primary">
        {num}
      </div>
      <div className="text-sm leading-7 text-text-secondary">{children}</div>
    </div>
  );
}

// ── Progress rail ────────────────────────────────────────────────────────────
// A shared, three-node stepper across the whole flow so setup reads as forward
// motion — completed nodes flip to a green ✓, the current node glows. Plan
// selection that follows is a dismissible modal, not a rail step.
type StepId = 'connect' | 'capture' | 'personalize';

const STEP_ORDER: { id: StepId; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'capture', label: 'First brief' },
  { id: 'personalize', label: 'Personalize' },
];

function StepRail({ current, done }: { current: StepId; done?: StepId[] }) {
  const currentIdx = STEP_ORDER.findIndex((s) => s.id === current);
  const doneSet = new Set(done ?? []);
  return (
    <ol className="mb-8 flex items-center" aria-label="Setup progress">
      {STEP_ORDER.map((step, i) => {
        const isDone = doneSet.has(step.id) || i < currentIdx;
        const isCurrent = step.id === current;
        return (
          <Fragment key={step.id}>
            <li className="flex items-center gap-2" aria-current={isCurrent ? 'step' : undefined}>
              <span
                className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors ${
                  isDone
                    ? 'border-primary bg-primary text-on-primary'
                    : isCurrent
                      ? 'border-primary/50 bg-primary/15 text-primary'
                      : 'border-border text-text-muted'
                }`}
              >
                {isDone ? '✓' : i + 1}
              </span>
              <span
                className={`text-xs font-medium max-sm:hidden ${
                  isCurrent ? 'text-text-primary' : isDone ? 'text-text-secondary' : 'text-text-muted'
                }`}
              >
                {step.label}
              </span>
            </li>
            {i < STEP_ORDER.length - 1 && (
              <span
                aria-hidden
                className={`mx-2.5 h-px flex-1 transition-colors ${i < currentIdx ? 'bg-primary/40' : 'bg-overlay-active'}`}
              />
            )}
          </Fragment>
        );
      })}
    </ol>
  );
}

// ── Live "is it working?" status ────────────────────────────────────────────
// /onboarding renders outside the dashboard shell, so it is NOT wrapped by
// DashboardBootstrapProvider. We poll the same endpoints the provider uses
// (bootstrap + local setup status) directly until the first session lands.
type ConnStatus = 'waiting' | 'detected' | 'synced';

// Returns the live connection status AND the durable activation flag.
//
// `status` answers "is a tool connected?" and drives the connect step. It is
// necessarily a poll, so it only sees what happens while this page is open.
//
// `hasFirstSync` answers "has this user actually been briefed?" — it is
// sync_health.has_first_sync, backed by the once-per-user first_sync_completed
// row the API writes on the first context delivery into any tool. Because it is
// server-side and durable, a sync that lands after the user closes the tab still
// counts. That distinction is the whole point: onboarding completion used to
// hang off the poll, so it could only fire for someone still sitting on the
// page — and PostHog showed every user who actually synced had missed it.
function useConnectionStatus(active: boolean): {
  status: ConnStatus;
  evidence: ConnectionEvidence;
  hasFirstSync: boolean;
  hasBrief: boolean;
  polledSinceVisible: boolean;
} {
  const [status, setStatus] = useState<ConnStatus>('waiting');
  // WHICH signal moved the status. Rides on onboarding_connection_detected so a
  // future regression is visible in the funnel instead of looking exactly like
  // the real thing.
  const [evidence, setEvidence] = useState<ConnectionEvidence>('none');
  const [hasFirstSync, setHasFirstSync] = useState(false);
  // Server-observed: a context_projects row exists. Explicitly NOT a connection
  // signal (that is the whole point of this file's fix) — it is what the capture
  // step reads to know a brief now exists, whoever wrote it.
  const [hasBrief, setHasBrief] = useState(false);
  // False until a round trip has RESOLVED since the tab last became visible, so
  // 'waiting' is never read as an answer when it is really just a stale skip.
  const [polledSinceVisible, setPolledSinceVisible] = useState(false);
  // Every activation hypothesis this project has written turns on a question the
  // funnel cannot answer: after someone copies the connector URL and leaves, do
  // they ever come back? Over 45 days 20 real people copied a config, 2 reached
  // an authorize screen and 0 established a connection — and nothing recorded
  // whether the other 18 returned to this tab and found it still saying
  // "Waiting", or simply never came back at all. Those are opposite problems.
  // The recheck handler below already fires on exactly that moment; it just
  // never said so.
  const returnCount = useRef(0);
  const awaySince = useRef<number | null>(null);
  // E-020. The `>= 2000ms` guard below tests the LENGTH of an absence and not its
  // ORIGIN, and that is not the same question. Adjudicating E-012 on 2026-09-04
  // found that 3 of its 4 events fired 2-6s after `onboarding_page_viewed`, before
  // the person had copied anything — a blur/focus pair thrown by the page settling
  // after the client-side navigation into /onboarding, which clears a two-second
  // bar whenever the gap happens to be longer than two seconds. Only one of the
  // four was a real return from another application (642s away, 69s after mount,
  // after a copy). Left alone this instrument reports the copy->return rate the
  // activation diagnosis divides by, 3x too high.
  //
  // So anchor the guard to the step's own mount instead: an absence that BEGINS
  // inside the first 10s of mounting is load-time churn, not somebody leaving to
  // paste a URL into Claude. The fastest real copy observed on this step is 24s
  // after mount, and the fastest copy->consent->approve traversal ever recorded
  // here is 28s end to end, so the window has room. Where it is wrong it
  // undercounts, which is the safe direction for a denominator. The rule itself
  // lives in lib/connectReturn.ts so it can be tested as logic rather than pinned
  // as source text.
  const mountedAt = useRef<number | null>(null);
  // Read inside the listener, which is registered once — a closed-over `status`
  // would report 'waiting' forever.
  const statusRef = useRef<ConnStatus>('waiting');
  useEffect(() => { statusRef.current = status; }, [status]);

  useEffect(() => {
    if (!active) return;
    // The clock E-020's grace window is measured against. Set here rather than at
    // render so a re-render cannot restart it and re-open the window.
    if (mountedAt.current === null) mountedAt.current = Date.now();
    let cancelled = false;
    let done = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (cancelled || done) return;
      // Skip the round-trip while the tab is hidden. The signal is server-side and
      // persistent, so nothing is lost by waiting until the user is actually back —
      // and this step deliberately sends them away to configure their tool.
      if (!inFlight && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        inFlight = true;
        try {
          const [data, setup] = await Promise.all([
            api.getDashboardBootstrap(),
            api.getLocalSetupStatus().catch(() => null),
          ]);
          if (cancelled) return;
          // Every signal this step is allowed to reason about, named in one
          // place. has_projects and recently_active are passed in and ignored by
          // connectionEvidence — see the note there for why they are handed over
          // rather than dropped here.
          const signals: ConnectionSignals = {
            mcpRegistered: Boolean(data.sync_health?.mcp_registered),
            hasFirstSync: Boolean(data.sync_health?.has_first_sync),
            runtimeVerified: (setup?.runtime_verified_count ?? 0) > 0,
            hasProjects: Boolean(data.sync_health?.has_projects),
            recentlyActive: Boolean(data.sync_health?.recently_active),
          };
          const firstSync = Boolean(signals.hasFirstSync);
          const next = connectionStatus(signals);
          setStatus(next);
          setEvidence(connectionEvidence(signals));
          setHasFirstSync(firstSync);
          setHasBrief(Boolean(signals.hasProjects));
          // Stop ONLY on the terminal signal. Stopping on 'synced' used to end
          // the poll the moment has_projects went true, which is how the capture
          // step's "or let your AI write it" path dead-ended: the AI created the
          // project, the poll saw it, declared 'synced' and shut down — before
          // has_first_sync could ever arrive — leaving Continue disabled with
          // nothing left running that could enable it.
          if (firstSync) { done = true; inFlight = false; return; } // activated — nothing left to watch for
        } catch {
          // Transient failure — keep polling.
        }
        inFlight = false;
        if (!cancelled) setPolledSinceVisible(true);
      }
      timer = setTimeout(poll, nextPollDelay(Date.now() - (mountedAt.current ?? Date.now())));
    };

    // The entire point of this step is that the user LEAVES — to paste a URL into
    // Claude, Cursor or ChatGPT and sign in. Re-check the instant they return so
    // "it worked" is already on screen rather than up to 4s away. `visibilitychange`
    // covers a tab switch; `focus` covers coming back from another application,
    // which is the actual path here and does not fire visibilitychange.
    const recheck = () => {
      if (cancelled || done) return;
      // Returning to the tab invalidates whatever the last poll concluded — the
      // user has been away doing exactly the thing we are watching for.
      const leftAt = awaySince.current;
      const awayMs = leftAt === null ? null : Date.now() - leftAt;
      awaySince.current = null;
      // How far into the step the absence STARTED. This is the discriminator
      // E-012 lacked, and it is stamped on every event that survives so the next
      // reader can see the distribution instead of reconstructing it from
      // neighbouring timestamps the way this one had to.
      const departedAfterMs =
        leftAt === null || mountedAt.current === null ? null : leftAt - mountedAt.current;
      // Only a real absence counts, on both axes. A focus event with no preceding
      // blur is the browser settling after load, not a user coming back from
      // Claude, and counting it would make the return rate read 100% by
      // construction — and per E-020 a blur/focus pair thrown while the page is
      // still settling clears that bar too, so the departure must also have
      // happened after the step had a chance to be read.
      const candidate = { awayMs, departedAfterMs };
      if (isRealReturn(candidate)) {
        returnCount.current += 1;
        trackProductEvent('connect_step_returned', {
          source: 'dashboard',
          path: '/onboarding',
          metadata: {
            surface: 'onboarding_flow',
            step: 'connect',
            return_index: returnCount.current,
            away_seconds: Math.round(candidate.awayMs / 1000),
            // Seconds between the step mounting and the user leaving it. Under
            // RETURN_GRACE_MS this event is not emitted at all, so every value
            // here is >= that floor; the series exists to show how far above it
            // real departures sit.
            seconds_since_mount: Math.round(candidate.departedAfterMs / 1000),
            // What the page was telling them at the moment they walked back in.
            status_on_return: statusRef.current,
          },
        });
      }
      setPolledSinceVisible(false);
      if (timer) clearTimeout(timer);
      poll();
    };
    // The departure half. `blur` covers switching to another application, which
    // is the actual path here (Claude's desktop app, a terminal); visibilitychange
    // covers a tab switch. Either one starts the clock.
    const markAway = () => {
      if (cancelled || done) return;
      if (awaySince.current === null) awaySince.current = Date.now();
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? recheck() : markAway());
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', recheck);
    window.addEventListener('blur', markAway);

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('blur', markAway);
    };
  }, [active]);

  return { status, evidence, hasFirstSync, hasBrief, polledSinceVisible };
}

// Fires `onSeen` once, the first time the node is at least half on screen.
//
// Deliberately NOT on mount: E-005's lesson (and the homepage demo's before it)
// is that a mount-time impression counts "the component exists", which is a fact
// about our JSX rather than about the user. Threshold 0.5 means the block was
// actually in front of someone.
function useSeenOnce(onSeen: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const fired = useRef(false);
  const cb = useRef(onSeen);

  // Kept fresh in an effect rather than assigned during render: a ref write
  // during render is not a render output, and React's lint rule is right to
  // reject it. The observer below reads cb.current only when it fires.
  useEffect(() => { cb.current = onSeen; }, [onSeen]);

  useEffect(() => {
    const node = ref.current;
    if (!node || fired.current) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || fired.current) continue;
          fired.current = true;
          cb.current();
          obs.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  return ref;
}

// "Make it automatic" — the step that was missing from this page entirely.
//
// The connect step ended on "Come back here. This page notices the moment your
// tool connects", and SIGN_IN_STEPS closes with "the DeerDawn tools are ready to
// use". Both are true and both stop one sentence short: a connected tool calls
// nothing until something tells it to. Measured 2026-08-26 — 3 of the 8 accounts
// that ever completed a handshake have never produced a single tool call, and
// their connectors kept re-handshaking for days afterwards. connection_established
// requires a start_session that reaches the server, so those accounts are not
// merely unactivated, they are structurally unable to activate.
//
// This is the user's own tool configuration, not a model-readable field we
// publish — the distinction the ChatGPT Fair Play review turned on. We hand them
// the text; they choose to install it.
function AutomationPromptCard({ tool }: { tool: string }) {
  const setup = AUTOMATION_SETUP[tool] ?? DEFAULT_AUTOMATION_SETUP;
  const ref = useSeenOnce(() => {
    trackProductEvent('connect_automation_shown', {
      source: 'dashboard',
      path: '/onboarding',
      metadata: { tool, surface: 'onboarding_connect_automation' },
    });
  });

  return (
    <div ref={ref} className="mt-5 rounded-2xl border border-border-strong bg-overlay-subtle p-5">
      <div className="text-sm font-semibold text-text-primary">One more step, or your AI won’t use it</div>
      <p className="mt-1.5 text-[13px] leading-6 text-text-secondary">
        Connecting DeerDawn does not make your AI read it. Nothing runs until the tool is asked. Paste this into{' '}
        <span className="text-text-primary">{setup.where}</span> and every session opens briefed, with nothing to remember.
      </p>
      <div className="mt-3 overflow-hidden rounded-xl border border-border-subtle">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-[var(--code-bg)] px-3 py-2">
          <span className="font-mono text-[11px] text-text-muted">Standing instruction for {tool}</span>
          <CopyButton
            text={setup.prompt}
            label="Copy"
            prominent
            onCopy={() => trackProductEvent('connect_automation_copied', {
              source: 'dashboard',
              path: '/onboarding',
              metadata: { tool, surface: 'onboarding_connect_automation' },
            })}
          />
        </div>
        <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap bg-[var(--code-bg)] p-3 font-mono text-xs leading-[1.6] text-text-secondary">{setup.prompt}</pre>
      </div>
      <p className="mt-3 text-[12px] leading-5 text-text-muted">
        Rather not? Then just say <span className="text-text-primary">“load my DeerDawn project”</span> at the start of a
        chat. The instruction only saves you from having to remember.
      </p>
    </div>
  );
}

function LiveStatus({ status }: { status: ConnStatus }) {
  const tone = status === 'waiting'
    ? 'border-border-subtle bg-overlay-subtle'
    : 'border-primary/30 bg-primary/[0.07]';

  return (
    <div className={`flex items-start gap-3 rounded-2xl border p-4 ${tone}`}>
      {status === 'waiting' ? (
        <span className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-primary" />
      ) : (
        <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-on-primary">✓</span>
      )}
      <div className="text-sm leading-6">
        {status === 'waiting' && (
          <>
            <span className="font-semibold text-text-primary">Waiting for your tool to connect…</span>
            <span className="text-text-secondary"> Add the URL and sign in — this updates automatically.</span>
          </>
        )}
        {status === 'detected' && (
          <>
            <span className="font-semibold text-text-primary">Connected — but nothing has been asked of it yet.</span>
            <span className="text-text-secondary"> Your tool has DeerDawn; it won&apos;t call it on its own. Set the standing
              instruction below, or just ask it for your brief in your next chat.</span>
          </>
        )}
        {status === 'synced' && (
          <>
            <span className="font-semibold text-text-primary">You’re briefed — every new session starts caught up.</span>
            <span className="text-text-secondary"> Every tool you connect now picks up the brief.</span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Step 1: connect (remote-first) ──────────────────────────────────────────
function ConnectStep({ onContinue, onExitEarly }: { onContinue: (verified: boolean) => void; onExitEarly: () => void }) {
  // Diagnostics for the step that has produced no completions since 2026-07-26.
  // `primary_cta_seen` is the load-bearing field: it separates "read it and gave
  // up" from "never scrolled far enough to see the button" — opposite problems
  // with opposite fixes, and previously indistinguishable. primaryCtaRef goes on
  // the mobile "Open Claude" link, which on a phone IS the action, and on desktop
  // on the tool picker, which is the equivalent decision there.
  const { primaryCtaRef, markResolved } = useStepDiagnostics({
    event: 'connect_step_exited',
    path: '/onboarding',
    metadata: { surface: 'onboarding_flow', step: 'connect' },
  });
  const [activeTab, setActiveTab] = useState<ToolTab>('claude');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedTool, setSelectedTool] = useState<string>(REMOTE_SETUP_LOCATIONS[0].tool);
  // C-3: flips once, CONNECTION_TIMEOUT_MS after the step mounts. Only ever read
  // alongside `status === 'waiting'`, so a connection that lands inside the
  // window means the fallback is never rendered at all.
  const [waitedOut, setWaitedOut] = useState(false);
  const noInstallOffered = useRef(false);
  const cliManualOpened = useRef(false);
  // The per-tool instruction panel. Picking a tool changes only the text INSIDE
  // this block, which on a phone sits below the fold — so a tap produced no
  // visible change and users tapped the next pill instead. PostHog caught the
  // result: one person cycled 6 tools in 10s, another 5 in 3s (147ms apart at
  // the tightest). Scrolling the panel into view makes the choice land.
  const toolStepsRef = useRef<HTMLDivElement | null>(null);
  // Browsing the picker is not choosing a path. The first pick is the funnel
  // step; later changes are the user hunting, which is worth seeing separately
  // rather than counted as six setup starts.
  const pathChosen = useRef(false);
  // Which tool a copy was taken against, and whether the user actually chose it.
  //
  // WHY: the picker below fires `setup_path_selected` only when the clicked tool
  // DIFFERS from the current one, and `selectedTool` starts on
  // REMOTE_SETUP_LOCATIONS[0] — 'Claude.ai'. So a Claude.ai user, who is 16 of
  // the 17 config copies in the 30 days to 2026-09-01, cannot fire that event
  // from this picker at all: their tool is already selected, so there is nothing
  // to change. Measured the same day: of the 43 people who reached a setup
  // surface, 8 selected a path AND copied, 9 selected without copying, and 8
  // copied WITHOUT EVER SELECTING. That last group is not a funnel drop-out, it
  // is the default path, and no event distinguished it from a deliberate pick.
  //
  // Recorded on the copy rather than as a new event: the copy is where the
  // distinction is actually needed, and a synthetic "you accepted the default"
  // event would inflate `setup_path_selected` to ~100% and destroy a series that
  // six weeks of growth reports are calibrated against.
  const toolSource = () => (pathChosen.current ? 'picked' : 'default');
  const didMountTool = useRef(false);
  const { status, evidence, polledSinceVisible } = useConnectionStatus(true);
  const firedConnected = useRef(false);
  // Cleared on unmount so a pending auto-advance cannot fire after the user has
  // already left the step by another route.
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // SSR-safe: false on the server and on desktop, so the "Works on this phone"
  // pill only ever renders on small screens.
  const isMobile = useIsMobile();
  // Mobile-only "email me the desktop setup link" — the recovery path for phones
  // that can't wire an MCP server into a desktop tool.
  const [setupLinkState, setSetupLinkState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  // ── One-tap copy-and-open (2026-08-16) ─────────────────────────────────────
  // The mobile card asked for two taps in a fixed order: copy the URL (Step 1),
  // then open Claude (Step 2). Nothing enforced the order, and the Step 2 button
  // is a full-width primary while Step 1's copy is an 11px icon button beside a
  // code block — so most people tapped the big one first.
  //
  // Measured over the 30 days to 2026-08-16, on surface `onboarding_mobile_first`:
  // 9 people tapped "Open Claude", and 5 of them had NEVER copied the URL. They
  // landed on Claude's "Add custom connector" screen with an empty clipboard and
  // nothing to paste. All 5 are dead — none reached oauth_consent_viewed.
  //
  // The one person who has ever completed a mobile connection (77aaac13) did the
  // round trip by hand: tapped Open Claude, came back 21s later, copied, tapped
  // again — then consented and started a runtime 30s after that. The successful
  // path was a manual repair of this defect.
  //
  // So the primary action now does both. The clipboard write is initiated
  // synchronously inside the click gesture and deliberately NOT awaited: awaiting
  // would move the anchor's navigation out of the user gesture and into
  // popup-blocker territory on mobile Safari. Step 1 remains as the fallback for
  // a rejected/unavailable clipboard.
  const [phoneUrlCopied, setPhoneUrlCopied] = useState(false);
  const copyUrlAndOpenClaude = () => {
    try {
      navigator.clipboard?.writeText(REMOTE_MCP_URL).then(
        () => {
          setPhoneUrlCopied(true);
          setTimeout(() => setPhoneUrlCopied(false), 4000);
        },
        () => { /* Step 1 above is the fallback; the navigation still proceeds. */ },
      );
    } catch { /* Older WebViews expose no clipboard at all — same fallback. */ }
    // `via` separates these from the two-tap events so the before/after is still
    // readable. NOTE: mcp_config_copied on this surface will rise mechanically
    // once this ships — it is now emitted by the action most people already took.
    // Judge this patch on oauth_consent_viewed, not on copies.
    trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_mobile_first', tool: PHONE_PRIMARY_TOOL, via: 'combined_cta' } });
    trackProductEvent('setup_path_selected', { source: 'dashboard', path: '/onboarding', metadata: { tool: PHONE_PRIMARY_TOOL, surface: 'onboarding_mobile_first', via: 'combined_cta' } });
  };

  // `via` separates the two places this can be tapped — the phone card's own
  // offer and the dead-end recovery further down — which were previously
  // indistinguishable in the funnel.
  const emailMeTheSetupLink = async (via: 'phone_card' | 'dead_end_recovery') => {
    setSetupLinkState('sending');
    try {
      const user = await api.getCurrentUser();
      if (!user?.email) { setSetupLinkState('error'); return; }
      await api.requestMobileSetupLink(user.email);
      trackProductEvent('mobile_setup_link_requested', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding', tool: selectedTool, via } });
      setSetupLinkState('sent');
    } catch {
      setSetupLinkState('error');
    }
  };

  // C-3 uptake. Taking the fallback IS choosing a setup path, so it rides the
  // same event the picker uses — a separate event name would have made it
  // invisible in the funnel this change has to be judged on. `surface` and `via`
  // keep it separable from a picker choice, and `from` records the local path it
  // rescued the user out of. pathChosen is latched so a later picker click is
  // correctly reported as a change of path rather than a second first-pick.
  const takeNoInstallPath = () => {
    trackProductEvent('setup_path_selected', {
      source: 'dashboard',
      path: '/onboarding',
      metadata: { tool: NO_INSTALL_TOOL, surface: 'onboarding_timeout_fallback', via: 'no_install_fallback', from: selectedTool },
    });
    pathChosen.current = true;
    setSelectedTool(NO_INSTALL_TOOL);
  };

  // Show what just changed. The per-tool steps sit below the fold on a phone, so
  // without this a tap looks like a no-op — which is what produced the cycling.
  // Runs on change only: scrolling on first paint would yank the page on load.
  useEffect(() => {
    if (!didMountTool.current) { didMountTool.current = true; return; }
    toolStepsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedTool]);

  useEffect(() => {
    markOnboardingStart();
    trackProductEvent('onboarding_page_viewed', { source: 'dashboard', path: '/onboarding' });
    trackProductEvent('mcp_setup_viewed', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding' } });
  }, []);

  // Wall clock from arriving on the step, not accumulated visible time: this step
  // exists to send the user away to their tool, so most of the three minutes is
  // spent in another window. Someone who comes back connected re-checks on focus
  // and leaves 'waiting' before this can render anything.
  useEffect(() => {
    const timer = setTimeout(() => setWaitedOut(true), CONNECTION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    // Funnel step 6 ("MCP connected") = first time we leave the waiting state.
    // 'detected' (mcp_registered, no sync yet) and 'synced' (first sync landed)
    // are BOTH connected; the real state rides in metadata.status so the funnel
    // can separate connect (step 6) from first sync / activation (step 7).
    if (status !== 'waiting' && !firedConnected.current) {
      firedConnected.current = true;
      // A connection landing is a real outcome even if they never click Continue,
      // so record it. A later Continue/exit overwrites it — last state wins, which
      // is what we want.
      markResolved('connected');

      // C2: the moment the connection is verified there is nothing left to decide,
      // so stop asking. The short delay is deliberate — the status pill flips to
      // "Connected." first, so the screen change reads as a consequence of what
      // they just did rather than the page moving under them. Especially matters
      // on mobile, where the user is returning from another app and needs a beat
      // to see that it worked.
      const timer = setTimeout(() => {
        markResolved('auto_advanced');
        onContinue(true);
      }, 1500);
      autoAdvanceTimer.current = timer;
      // `surface` is load-bearing, not decorative. SampleBriefEmptyState emits
      // this SAME event name on a later dashboard load under a completely
      // different condition, and it already carries surface:'dashboard_brief'.
      // Until this emitter carried one too, the property was present on one
      // emitter and absent on the other, so the two could not be separated in
      // PostHog and every breakdown silently mixed a poll-conditioned sample
      // with a zero-project-conditioned one. Same discriminator convention as
      // onboarding_step_completed / onboarding_completed.
      //
      // Read the DO-NOT-USE note for this event in docs/growth/funnel-tracking.md
      // before building anything on its counts: presence is trustworthy, absence
      // is not.
      // `evidence` names the signal that moved the status: 'handshake' (an
      // authenticated source='mcp' row, or a verified local runtime) or
      // 'first_sync' (a brief that actually reached a tool). It can never be
      // 'none' on this branch — connectionStatus leaves 'waiting' only when
      // connectionEvidence finds something, and connectionEvidence.test.ts
      // asserts that exhaustively. It is on the payload so that if a
      // has_projects-shaped signal is ever folded back in, the funnel shows a
      // new value rather than silently more of the old one.
      trackProductEvent('onboarding_connection_detected', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_poll', status, evidence } });
    }
    // markResolved is stable (useCallback with no deps) but listing it keeps the
    // lint rule honest rather than silenced.
  }, [status, evidence, markResolved, onContinue]);

  useEffect(() => () => {
    if (autoAdvanceTimer.current) clearTimeout(autoAdvanceTimer.current);
  }, []);

  const advancedConfig = buildAdvancedConfig(activeTab);
  const activeMeta = ADVANCED_TABS.find(t => t.id === activeTab)!;
  const selectedLocation = REMOTE_SETUP_LOCATIONS.find((l) => l.tool === selectedTool)?.where ?? '';
  // Present for the CLI tools, which get a command instead of a URL to paste into
  // a settings menu they do not have.
  const cliSetup = CLI_SETUP[selectedTool];
  // C-3. Desktop only: the mobile card above already LEADS with this exact path,
  // so on a phone the fallback would be an offer to do what the user is already
  // being asked to do. Suppressed for the hosted tools for the same reason.
  const showNoInstallFallback =
    !isMobile && waitedOut && status === 'waiting' && polledSinceVisible && !NO_INSTALL_TOOLS.has(selectedTool);

  // The denominator for the fallback's setup_path_selected — without it, uptake
  // has nothing to be a share of.
  useEffect(() => {
    if (showNoInstallFallback && !noInstallOffered.current) {
      noInstallOffered.current = true;
      trackProductEvent('onboarding_no_install_offered', {
        source: 'dashboard',
        path: '/onboarding',
        metadata: { surface: 'onboarding_timeout_fallback', tool: selectedTool, after_ms: CONNECTION_TIMEOUT_MS },
      });
    }
  }, [showNoInstallFallback, selectedTool]);
  // Catch-all picker entry ("Windsurf, Gemini, others") — a list of tools, not one
  // tool, so it needs different sentence construction than the named entries.
  const isCatchAllTool = selectedTool.includes('others');
  // `deepLink` (PHONE_DEEP_LINKS[selectedTool]) used to live here, feeding a
  // mobile block inside the desktop card. The mobile-first card above replaced
  // that block and always targets Claude, so the per-tool lookup has no
  // remaining reader. The picker's "On this phone" pill still reads
  // PHONE_DEEP_LINKS directly.

  return (
    <div className="min-h-screen bg-background text-text-primary">
      <div className="relative mx-auto flex min-h-screen max-w-3xl items-center px-6 py-12 max-sm:py-6 lg:px-10">
        <div className="w-full">
          <section className="rounded-[32px] border border-border-subtle bg-overlay-subtle p-8 shadow-[0_30px_90px_rgba(0,0,0,0.24)] max-sm:rounded-3xl max-sm:p-6 lg:p-10">
            <StepRail current="connect" done={status !== 'waiting' ? ['connect'] : []} />
            <div className="dashboard-eyebrow">Step 1 · Connect a tool</div>
            <h1 className="mt-3 text-[clamp(2.2rem,5vw,3.6rem)] font-semibold leading-[0.94] tracking-[-0.06em] text-text-primary max-sm:mt-2 max-sm:text-[1.75rem]">
              Connect once. Every session starts briefed.
            </h1>
            {/* Two versions of the same promise. On a phone the long form pushed
                the primary action ("Open Claude") to y=680 on a 664px viewport —
                below the fold, behind a wall of prose. Swapped with CSS rather
                than isMobile so there is no hydration flash, and the >= sm render
                stays byte-identical. */}
            <p className="mt-4 max-w-xl text-[15px] leading-7 text-text-secondary max-sm:hidden">
              DeerDawn briefs every new session with your project’s task, decisions, and where you left off — across Claude, ChatGPT, Cursor, and Codex. Add one URL, sign in through your browser — no API keys to copy.
            </p>
            <p className="mt-2.5 hidden text-[14px] leading-6 text-text-secondary max-sm:block">
              Add one URL and every new session starts briefed — no API keys.
            </p>

            {/* ── Mobile-first connect ────────────────────────────────────────
                A phone cannot wire an MCP server into a desktop tool, but it CAN
                add a remote connector in Claude. The desktop-shaped content below
                (tool picker, per-tool menu paths, local JSON config) is unusable
                on a phone and buried the one action that works, so on small
                screens we lead with the Claude path and a Continue button that is
                reachable without scrolling past any of it.

                Gated on isMobile, which is false on the server and on desktop, so
                the desktop render stays pixel-identical. */}
            {isMobile && (
              <div className="mt-8 rounded-[24px] border border-primary/30 bg-primary/[0.08] p-5">
                <div className="text-base font-semibold text-text-primary">Finish right here on your phone</div>
                <p className="mt-1.5 text-[13px] leading-6 text-text-secondary">
                  Claude supports remote connectors on mobile — no computer needed. One tap:
                </p>

                <div className="mt-4 space-y-3">
                  <div className="rounded-xl border border-border-subtle bg-surface p-3">
                    {/* No longer "Step 1" — the button below copies this. Kept
                        visible as the fallback for a rejected clipboard, and so
                        the user can see what is about to be pasted. */}
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">The connector URL</div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <code className="break-all text-xs text-primary">{REMOTE_MCP_URL}</code>
                      <CopyButton
                        text={REMOTE_MCP_URL}
                        onCopy={() => trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_mobile_first', tool: PHONE_PRIMARY_TOOL, via: 'url' } })}
                      />
                    </div>
                  </div>

                  <div className="rounded-xl border border-border-subtle bg-surface p-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Add it to Claude</div>
                    <p className="mt-1.5 text-[13px] leading-6 text-text-secondary">
                      Copies the URL and opens <strong className="text-text-primary">{CONNECTOR_MENU_PATHS[PHONE_PRIMARY_TOOL].menu}</strong>. Tap <strong className="text-text-primary">{CONNECTOR_MENU_PATHS[PHONE_PRIMARY_TOOL].action}</strong>, paste, and leave the OAuth fields blank.
                    </p>
                    <a
                      ref={primaryCtaRef}
                      href={PHONE_DEEP_LINKS[PHONE_PRIMARY_TOOL].url}
                      target="_blank"
                      rel="noopener noreferrer"
                      // The pivotal mobile action, and now the only tap required.
                      // Distinct surface so mobile activation is measurable on its
                      // own, rather than being averaged into a desktop funnel it
                      // never belonged in. See copyUrlAndOpenClaude for why 5 of 9
                      // people used to arrive here with an empty clipboard.
                      onClick={copyUrlAndOpenClaude}
                      className="ui-press ui-focus mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/15 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/25"
                    >
                      {phoneUrlCopied ? '✓ URL copied — opening Claude' : `Copy URL & ${PHONE_DEEP_LINKS[PHONE_PRIMARY_TOOL].label.toLowerCase()}`} →
                    </a>
                  </div>
                </div>

                <div className="mt-4">
                  <LiveStatus status={status} />
                </div>

                {/* Continue lives here too, so a phone user never has to scroll
                    past the desktop instructions to move forward.

                    This button used to be `disabled={status === 'waiting'}` — the
                    same dead-button pattern #288 removed from the desktop step,
                    left in place on the branch that needed it most. Its stated
                    reason was that an ungated mobile Continue would drop the user
                    into "a capture step that cannot produce a brief without a
                    connection". #296 made that false: the capture step now seeds a
                    brief in-page via createContextProject, no connection required.
                    The justification expired; the gate outlived it.

                    What it cost: over the 30 days to 2026-08-14, 16 of 32 real
                    signups were on mobile. 15 reached onboarding, 7 picked a setup
                    path, 5 copied the URL — and ZERO ever started a runtime. On a
                    phone the only enabled control on this card was "I'll finish
                    this later", and 2 of 32 signups ever came back on a later day.

                    On mobile the capture step now comes FIRST (see Onboarding
                    below), so by the time a phone user reaches this card they
                    already have a brief saved and connecting is the last step, not
                    the toll gate. */}
                <div className="mt-4">
                  <Button onClick={() => { markResolved('continued_mobile'); onContinue(status !== 'waiting'); }}>
                    {status === 'waiting' ? 'Done — finish setup later →' : 'Connected — you’re all set →'}
                  </Button>
                </div>
                <button
                  type="button"
                  onClick={() => { markResolved('exited_early'); onExitEarly(); }}
                  className="ui-focus mt-2 w-full rounded-lg px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary"
                >
                  I&apos;ll finish this later
                </button>

                {/* Label restored to the universal wording it had before #250
                    (2026-08-04) rephrased it to "Using Cursor or Codex? Email me
                    the desktop link".

                    Nothing gated it in code — it renders for every mobile user —
                    but the qualifier names two tools, and the phone card's own
                    default is Claude.ai. A phone user on Claude reads the first
                    three words and correctly concludes the offer is not for them.

                    The funnel shows exactly that shape. Weekly mobile people
                    reaching this step vs requests: 10 -> 3, then the rephrase
                    lands mid-week, then 8 -> 1, 8 -> 0, 9 -> 0. Traffic flat,
                    uptake to zero, and it has stayed zero since 2026-08-04.

                    Wanting to finish setup at a computer is not a Cursor-and-Codex
                    problem, it is a being-on-a-phone problem. The tool-specific
                    version of this offer already exists lower down, next to the
                    wall it rescues people from. */}
                <button
                  type="button"
                  onClick={() => emailMeTheSetupLink('phone_card')}
                  disabled={setupLinkState === 'sending' || setupLinkState === 'sent'}
                  className="ui-press ui-focus mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
                >
                  {setupLinkState === 'sent' ? 'Sent — check your inbox' : setupLinkState === 'sending' ? 'Sending…' : 'Email me the desktop setup link'}
                </button>
                {setupLinkState === 'error' && (
                  <span className="mt-2 block text-xs text-status-danger">Couldn’t send just now — try again, or email support@deerdawn.com.</span>
                )}
              </div>
            )}

            {/* Desktop-first zero-navigation path. The hosted prompt routes the
                current AI to client-specific instructions, configures MCP directly
                where the host allows it, and stops only for approval or OAuth.
                Not on a self-hosted install: those instructions are hosted ones
                and would connect the tool to api.deerdawn.com. */}
            {!SELF_HOSTED_API_URL && (
            <div className="mt-8 rounded-[24px] border border-primary/30 bg-primary/[0.08] p-5 max-sm:hidden lg:p-6">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Fastest setup</div>
              <h2 className="mt-2 text-xl font-semibold text-text-primary">Let your AI connect itself</h2>
              <p className="mt-2 max-w-2xl text-[14px] leading-7 text-text-secondary">
                Paste one prompt into Codex, Claude, Cursor, ChatGPT, or another AI tool. It detects where it is running, installs DeerDawn when possible, and only hands control back for approval or browser sign-in.
              </p>
              <div className="mt-4">
                <CopyButton
                  text={AGENT_SETUP_PROMPT}
                  label="Copy one-step setup prompt"
                  prominent
                  onCopy={() => trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_agent_setup', tool: selectedTool, tool_source: toolSource(), via: 'agent_prompt' } })}
                />
              </div>
              <p className="mt-3 text-xs text-text-muted">Come back here after sign-in. This page detects the connection automatically.</p>
            </div>
            )}

            {/* Connect — tool-first, one path */}
            <div className="mt-8 rounded-[24px] border border-border-subtle bg-surface p-5 lg:p-6">
              {/* On a phone this whole block is the secondary path — the mobile
                  card above already carries the action that works there. */}
              {isMobile && (
                <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Or set it up on a computer</div>
              )}
              {!isMobile && (
                <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">Or connect it yourself</div>
              )}

              {/* Which tool FIRST. This is the one decision on the page, and everything
                  below renders for that tool only. Previously the page led with two
                  generic paths (an "ask your AI" prompt and a bare URL) before asking
                  which tool the user had, so nobody saw instructions that matched their
                  situation until they scrolled past two that didn't. Decision time rises
                  with the number of visible options (Hick's Law), and this audience is
                  novice at MCP setup — exactly where that cost bites. */}
              <div className="text-base font-semibold text-text-primary">Which tool are you using?</div>
              {/* On desktop THIS is the primary action — picking a tool is the one
                  decision on the page and the step the cohort dies at (17 reached
                  onboarding in the 7d to 2026-08-11, 6 selected a path). The ref
                  was only ever on the mobile deep link, so desktop reported
                  primary_cta_seen=false by construction. Mutually exclusive with
                  the mobile attachment, and the hook re-observes on node change. */}
              <div className="mt-3 flex flex-wrap gap-1.5" ref={isMobile ? undefined : primaryCtaRef}>
                {REMOTE_SETUP_LOCATIONS.map((loc) => (
                  <button
                    key={loc.tool}
                    onClick={() => {
                      // Setup-path branch: which tool the user chose to wire up.
                      // The FIRST pick is the funnel step; re-picks are the user
                      // hunting for instructions that look right, so they get
                      // their own event instead of inflating setup-path starts.
                      if (loc.tool !== selectedTool) {
                        if (!pathChosen.current) {
                          pathChosen.current = true;
                          trackProductEvent('setup_path_selected', { source: 'dashboard', path: '/onboarding', metadata: { tool: loc.tool, surface: 'onboarding_remote_setup' } });
                        } else {
                          trackProductEvent('setup_path_changed', { source: 'dashboard', path: '/onboarding', metadata: { tool: loc.tool, from: selectedTool, surface: 'onboarding_remote_setup' } });
                        }
                      }
                      setSelectedTool(loc.tool);
                    }}
                    className={`ui-press ui-focus rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors max-md:inline-flex max-md:items-center max-md:gap-1.5 ${
                      selectedTool === loc.tool
                        ? 'border-primary/40 bg-primary/12 text-primary'
                        : 'border-border-subtle text-text-muted hover:text-text-secondary'
                    }`}
                  >
                    {loc.tool}
                    {/* Mobile-only: these tools' connector settings are reachable
                        from a phone browser. isMobile is false on desktop/SSR, so
                        this pill never renders >= md. */}
                    {isMobile && PHONE_DEEP_LINKS[loc.tool] && (
                      <span className="rounded-full bg-primary/15 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.06em] text-primary">
                        On this phone
                      </span>
                    )}
                    {/* The other half of that signal (2026-08-16). Only the
                        phone-completable tool was ever marked, so on a phone the
                        rest read as equally available — and they are not. Over
                        the 30 days to 2026-08-16, mobile setup_path_selected
                        split 9 Claude.ai / 8 desktop-only ("Windsurf, Gemini,
                        others" 5, ChatGPT.com 3): nearly half of every mobile
                        path choice went somewhere a phone cannot finish. The
                        "Or set it up on a computer" heading above is an 11px
                        muted line and did not carry it. */}
                    {isMobile && !PHONE_DEEP_LINKS[loc.tool] && (
                      <span className="rounded-full bg-overlay-active px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                        Needs a computer
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/* The ONE path for the selected tool. Claude Code registers MCP servers
                  through its CLI and cannot paste a URL into a menu, so it gets a command
                  and no URL block; every other tool gets the URL plus its exact menu
                  location. Showing both to everyone is what made this page feel like
                  homework. */}
              <div ref={toolStepsRef} className="mt-6 scroll-mt-4 border-t border-border-subtle pt-6">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  Setting up {selectedTool}
                </div>

                {/* Dead-end recovery (2026-08-16). A phone user who picks a
                    desktop-only tool was shown the same "open Settings → paste
                    this URL" instructions as a desktop user, for a menu that
                    does not exist on their device. The recovery already existed
                    — emailMeTheSetupLink — but only at the bottom of the mobile
                    Claude card ABOVE, so it was never adjacent to the moment the
                    user hit the wall. (That card's copy has since been restored
                    to a universal offer; this one stays because it names the
                    tool and sits at the wall.)
                    Rendered before the instructions so it is not something to
                    scroll for. */}
                {isMobile && !PHONE_DEEP_LINKS[selectedTool] && (
                  <div className="mb-5 rounded-xl border border-border-subtle bg-overlay-subtle p-4">
                    <div className="text-[13px] font-semibold text-text-primary">
                      {selectedTool} is set up on a computer
                    </div>
                    <p className="mt-1.5 text-[13px] leading-6 text-text-secondary">
                      The steps below need a desktop. Send yourself the link and finish in a minute when you are back at your machine — your brief is already saved.
                    </p>
                    <button
                      type="button"
                      onClick={() => emailMeTheSetupLink('dead_end_recovery')}
                      disabled={setupLinkState === 'sending' || setupLinkState === 'sent'}
                      className="ui-press ui-focus mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/15 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/25 disabled:opacity-60"
                    >
                      {setupLinkState === 'sent' ? 'Sent — check your inbox' : setupLinkState === 'sending' ? 'Sending…' : 'Email me the desktop link'}
                    </button>
                    {setupLinkState === 'error' && (
                      <span className="mt-2 block text-xs text-status-danger">Couldn’t send just now — try again, or email support@deerdawn.com.</span>
                    )}
                    <p className="mt-3 text-[12px] leading-5 text-text-muted">
                      Want it working right now? Claude.ai connects from this phone — pick it above.
                    </p>
                  </div>
                )}
                {cliSetup ? (
                  <>
                    <div className="text-sm font-semibold text-text-primary">{cliSetup.heading}</div>
                    <div className="mt-2 rounded-xl border border-primary/30 bg-[var(--code-bg)] p-3">
                      <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs leading-[1.7] text-text-secondary">{cliSetup.command}</pre>
                      <div className="mt-3">
                        {/* `via` separates the command path from the hand-edited
                            config below, so C-2 can be judged on which of the two
                            people take — mcp_config_copied alone cannot say. */}
                        <CopyButton
                          text={cliSetup.command}
                          label={cliSetup.copyLabel}
                          prominent
                          onCopy={() => trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { tool: selectedTool, tool_source: toolSource(), surface: 'onboarding_remote_setup', via: 'one_command' } })}
                        />
                      </div>
                    </div>
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] leading-6 text-text-secondary">
                      {cliSetup.does.map((line) => <li key={line}>{line}</li>)}
                    </ul>
                    <p className="mt-3 text-[13px] leading-6 text-text-secondary">
                      {cliSetup.then} Then come back — this page notices the moment it connects. To check from the
                      terminal, run <code className="text-xs text-primary">{cliSetup.verify}</code>.
                    </p>

                    {/* The manual config, demoted (C-2). It used to be the only
                        thing on screen for this tool: find the file, paste, restart,
                        with no signal when a step silently missed. It stays reachable
                        — `claude mcp add` is shelled out best-effort and can fail —
                        but it is no longer what the page opens with. */}
                    <details
                      className="mt-4 rounded-xl border border-border-subtle bg-overlay-subtle"
                      onToggle={(e) => {
                        if ((e.target as HTMLDetailsElement).open && !cliManualOpened.current) {
                          cliManualOpened.current = true;
                          trackProductEvent('onboarding_advanced_opened', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_cli_manual', tool: selectedTool } });
                        }
                      }}
                    >
                      <summary className="cursor-pointer list-none px-4 py-2.5 text-[13px] font-medium text-text-secondary hover:text-text-primary">
                        Advanced / manual setup
                      </summary>
                      <div className="border-t border-border-subtle px-4 pb-4 pt-3">
                        <div className="text-[13px] font-medium text-text-primary">{cliSetup.manual.label}</div>
                        <div className="mt-2 overflow-hidden rounded-lg border border-border-subtle">
                          <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-[var(--code-bg)] px-3 py-2">
                            <span className="font-mono text-[11px] text-text-muted">{cliSetup.manual.filePath}</span>
                            <CopyButton
                              text={cliSetup.manual.command}
                              onCopy={() => trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { tool: selectedTool, tool_source: toolSource(), surface: 'onboarding_remote_setup', via: 'manual' } })}
                            />
                          </div>
                          <pre className="m-0 overflow-x-auto bg-[var(--code-bg)] p-3 font-mono text-xs leading-[1.6] text-text-secondary">{cliSetup.manual.command}</pre>
                        </div>
                        {cliSetup.manual.authorize && (
                          <p className="mt-3 text-[12px] leading-5 text-text-muted">{cliSetup.manual.authorize}</p>
                        )}
                        <p className="mt-3 text-[12px] leading-5 text-text-muted">
                          Restart {selectedTool} afterwards — it only reads a newly added server at startup.
                        </p>
                      </div>
                    </details>
                  </>
                ) : (
                  <>
                    {/* The last picker entry is a catch-all ("Windsurf, Gemini, others"),
                        so the "In X, open Y" sentence doesn't grammatically fit it. */}
                    <div className="text-sm font-semibold text-text-primary">
                      {isCatchAllTool ? (
                        <>In your tool, <span className="text-primary">{selectedLocation.charAt(0).toLowerCase()}{selectedLocation.slice(1)}</span></>
                      ) : (
                        <>In {selectedTool}, open <span className="text-primary">{selectedLocation}</span></>
                      )}
                    </div>
                    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.06] p-4">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">Paste this URL</div>
                      <div className="mt-1.5 flex items-center gap-2">
                        <code className="break-all text-sm text-primary">{REMOTE_MCP_URL}</code>
                        <CopyButton
                          text={REMOTE_MCP_URL}
                          onCopy={() => trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { tool: selectedTool, tool_source: toolSource(), surface: 'onboarding_remote_setup', via: 'url' } })}
                        />
                      </div>
                    </div>
                    <div className="mt-4 space-y-3.5">
                      <StepRow num={1}>
                        Leave any OAuth client fields blank — there is no API key to create.
                      </StepRow>
                      <StepRow num={2}>
                        Click <strong className="text-text-primary">Connect</strong>. A DeerDawn tab opens — sign in and authorize.
                      </StepRow>
                      <StepRow num={3}>
                        Come back here. This page notices the moment your tool connects.
                      </StepRow>
                    </div>
                  </>
                )}
              </div>

              {/* The former mobile block lived here, inside the desktop card and
                  below the tool picker + per-tool steps. It has been replaced by
                  the mobile-first card above: on a phone the Claude path and
                  Continue now sit above all of this rather than under it. */}

              {/* Shown to everyone on this step, not gated on `status`. The two
                  users who connected and went silent in August left this page in
                  3 and 13 seconds respectively — a block that waits for detection
                  would have rendered for neither of them. */}
              <AutomationPromptCard tool={selectedTool} />

            </div>

            {/* Live status. Hidden on mobile — the mobile-first card above already
                renders it next to the action it reports on, and showing it twice
                on a phone reads as two different connection states. */}
            {!isMobile && (
              <div className="mt-5">
                <LiveStatus status={status} />
              </div>
            )}

            {/* No-install fallback (C-3). Renders BELOW the path the user picked,
                never in place of it, and only once three minutes have passed with
                nothing detected — at which point "nothing has arrived yet" is a
                fact rather than a guess. The hosted connector removes the whole
                class of failure the local paths can hit, and only 12% of accounts
                have ever reached oauth_consent_viewed, so most people stuck here
                have not seen it. */}
            {showNoInstallFallback && (
              <div className="mt-5 rounded-2xl border border-border-strong bg-overlay-subtle p-5">
                <div className="text-sm font-semibold text-text-primary">Nothing has checked in yet</div>
                <p className="mt-1.5 text-[13px] leading-6 text-text-secondary">
                  We haven’t seen a connection yet — it has been about {Math.round(CONNECTION_TIMEOUT_MS / 60000)} minutes.
                  Local setup can fail quietly — a config that landed in the wrong file, or a tool that has to be
                  restarted before it reads a newly added server.
                </p>
                <p className="mt-2.5 text-[13px] leading-6 text-text-secondary">
                  There is a path with nothing to install: add DeerDawn to <strong className="text-text-primary">Claude.ai</strong>{' '}
                  as a custom connector. One URL, browser sign-in, and nothing runs on your machine.
                </p>
                <button
                  type="button"
                  onClick={takeNoInstallPath}
                  className="ui-press ui-focus mt-3.5 inline-flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/15 px-4 py-2.5 text-sm font-semibold text-primary transition-colors hover:bg-primary/25"
                >
                  Show me the no-install path →
                </button>
                <p className="mt-3 text-[12px] leading-5 text-text-muted">
                  Already pasted it? Detection can lag a working connection — this keeps checking either way.
                </p>
              </div>
            )}

            {/* Advanced local install (collapsed) */}
            <details
              className="mt-5 rounded-2xl border border-border-subtle bg-overlay-subtle"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open && !advancedOpen) {
                  setAdvancedOpen(true);
                  // Labelled now that a second disclosure (the per-tool manual
                  // setup inside the CLI panel) emits the same event.
                  trackProductEvent('onboarding_advanced_opened', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_advanced' } });
                }
              }}
            >
              <summary className="cursor-pointer list-none px-5 py-3.5 text-sm font-medium text-text-secondary hover:text-text-primary">
                Advanced: install DeerDawn locally
              </summary>
              <div className="border-t border-border-subtle px-5 pb-5 pt-4">
                <p className="text-sm leading-7 text-text-secondary">
                  Coding tools can <em className="text-text-primary">optionally</em> run DeerDawn as a local process instead. It signs in the same way and adds:
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-7 text-text-secondary">
                  {ADVANCED_LOCAL_BULLETS.map((b) => <li key={b}>{b}</li>)}
                </ul>

                {/* Both bullets above are exactly what the setup command does on
                    its own, so a Claude Code user has no reason to hand-edit
                    anything here. Scoped to that tab because runSetup registers
                    the server with Claude Code and nothing else. */}
                {activeTab === 'claude' && (
                  <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-primary/25 bg-primary/[0.06] p-3">
                    <code className="break-all font-mono text-xs text-text-secondary">{ONE_COMMAND_SETUP}</code>
                    <CopyButton
                      text={ONE_COMMAND_SETUP}
                      label="Copy setup command"
                      onCopy={() => trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { tool: activeTab, surface: 'onboarding_advanced', via: 'one_command' } })}
                    />
                    <span className="text-[11px] leading-5 text-text-muted">Signs you in, registers the server and installs the hooks for Claude Code in one run — the repo files land once this directory is linked to a project.</span>
                  </div>
                )}

                <div className="mt-4 flex gap-1">
                  {ADVANCED_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`ui-press ui-focus rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${
                        activeTab === tab.id
                          ? 'border-primary/40 bg-primary/12 text-primary'
                          : 'border-border-subtle text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 overflow-hidden rounded-xl border border-border-subtle">
                  <div className="flex items-center justify-between border-b border-border-subtle bg-[var(--code-bg)] px-3 py-2">
                    <span className="font-mono text-[11px] text-text-muted">{activeMeta.filePath}</span>
                    <CopyButton
                      text={advancedConfig}
                      label="Copy config"
                      onCopy={() => trackProductEvent('mcp_config_copied', { source: 'dashboard', path: '/onboarding', metadata: { tool: activeTab, surface: 'onboarding_advanced', via: 'manual' } })}
                    />
                  </div>
                  <pre className="m-0 overflow-x-auto bg-[var(--code-bg)] p-3 font-mono text-xs leading-[1.6] text-text-secondary">{advancedConfig}</pre>
                </div>
                <p className="mt-3 text-[11px] leading-[1.5] text-text-muted">
                  Need a key for a header-auth-only tool? Create one in{' '}
                  <Link href="/setup#keys" className="text-primary hover:underline">API keys</Link> and send it as{' '}
                  <code className="text-[10px] text-primary">Authorization: Bearer &lt;key&gt;</code>.
                </p>
              </div>
            </details>

            {/* Continue → the first-brief step.
                Reports whether the connection is server-verified; never blocks on it.

                `status` leaves 'waiting' only once sync_health.mcp_registered is true,
                backed by source='mcp' product events the MCP server emits ONLY after
                auth resolves (apps/api/src/routes/shared/dashboard.js) — so a verified
                connection cannot be faked by clicking around the browser, and
                onboarding_completed still means the product actually worked.

                What changed (2026-08-12): this button used to be DISABLED while
                waiting. The intent was right — before the gate, users clicked past
                setup in 15-32s and were marked onboarding_completed having installed
                nothing. But disabling it fixed the event by breaking the step. The
                MCP handshake was returning 200 to anonymous clients for 39 days
                (fixed in #259), so verification could essentially never arrive:
                onboarding_connection_detected fired for ONE person in 30 days. That
                left "I'll finish this later" as the only enabled control on the page,
                and 11 of 29 signups took it within 17-80 seconds — the funnel reads
                29 reaching this step and 2 ever starting a runtime.

                So: honesty belongs in the event, not in a dead button. Continue always
                works, and verified_connection carries the truth. */}
            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Button onClick={() => { markResolved('continued'); onContinue(status !== 'waiting'); }}>
                {status === 'waiting' ? 'Continue — I’ll connect from my tool →' : 'Connected — next: your first brief →'}
              </Button>
              <button
                type="button"
                onClick={() => { markResolved('exited_early'); onExitEarly(); }}
                className="ui-focus rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                I&apos;ll finish this later
              </button>
            </div>
            {status === 'waiting' && (
              <p className="mt-3 text-xs text-text-muted">
                This flips to “Connected” by itself the moment your tool checks in — no need to refresh. Already
                pasted it? Go ahead and continue; detection can lag behind a working connection.
              </p>
            )}

            <p className="mt-5 text-xs text-text-muted">
              Per-tool menu locations, a connection test, and troubleshooting live in{' '}
              <Link href="/setup" className="text-primary hover:underline">Settings → Tools</Link>.
            </p>
            <p className="mt-2 text-xs text-text-muted">
              Stuck? Email{' '}
              <a href="mailto:support@deerdawn.com" className="text-primary hover:underline">support@deerdawn.com</a>{' '}
              and a human will help.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Step 2: capture the first brief ─────────────────────────────────────────
// The reframe: a fresh account has nothing to READ, so we stop telling people to
// "run start_session and see what you were working on" (empty) and instead make
// the productive move obvious — your first session WRITES the brief. Live status
// flips to a celebration the moment the first brief lands.
// `onBack` is optional: when capture leads the flow (mobile) there is no earlier
// screen, and a Back button there would walk the user out of the first thing they
// see. `captureFirst` also changes what the step promises — it cannot say "your
// AI will pick this up" as a past-tense fact when nothing is connected yet.
function CaptureStep({ onContinue, onBack, onExitEarly, captureFirst = false }: { onContinue: (activated: boolean) => void; onBack?: () => void; onExitEarly: () => void; captureFirst?: boolean }) {
  // Deliberately NOT `status` or `evidence`: this step is about whether a brief
  // exists, not about whether a tool is connected, and conflating those two is
  // exactly what went wrong on the connect step. `hasBrief` is has_projects —
  // useless as a connection signal, and the right one here.
  const { hasFirstSync, hasBrief } = useConnectionStatus(true);
  const firedBriefed = useRef(false);

  // Seeding the first brief from right here, instead of sending the user away to
  // paste a prompt into their AI tool. This is the last real gap in the activation
  // chain: connecting is not enough, because a fresh account has nothing saved, so
  // start_session returns an empty (suppressed) injection and emits no
  // context_delivered. Someone has to WRITE something before any session can open
  // briefed — and every step that sends the user off-site is a step they may not
  // come back from.
  //
  // `seeded` counts as briefed because the server returned 201 on a real project
  // create. That is a server confirmation, not the user asserting they did it —
  // the same standard the connect step is gated on.
  const [seeded, setSeeded] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [currentTask, setCurrentTask] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // hasFirstSync is the server's once-per-user first_sync_completed; `seeded` is
  // a 201 on a real project create, an equally server-confirmed outcome. What is
  // gone is `status === 'synced'`, a client-side proxy that missed every real user.
  //
  // `hasBrief` is the same standard as `seeded`, for a project this page did not
  // create. Without it the step offered a path nobody could finish: "Or let your
  // AI write it" hands over a prompt, the AI calls manage_memory, a project is
  // created — and none of that produces first_sync_completed, which is emitted on
  // context DELIVERY. An AI that writes a brief and does not read one back never
  // fires it, so Continue read "Waiting for your first brief…" while the brief
  // sat finished on the server. (The poll used to shut down at that same moment
  // too, on has_projects; that half is fixed in useConnectionStatus.)
  //
  // Unlocking when a brief demonstrably exists is the honest answer to the
  // question this step asks. It is NOT a claim that anything is connected —
  // onContinue still reports hasFirstSync, so onboarding_completed's first_sync
  // keeps meaning activation.
  const briefed = hasFirstSync || seeded || hasBrief;

  const saveFirstBrief = async () => {
    const name = projectName.trim();
    if (!name || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.createContextProject({
        project_name: name,
        current_task: currentTask.trim() || undefined,
      });
      setSeeded(true);
      trackProductEvent('project_created', {
        source: 'dashboard',
        path: '/onboarding',
        metadata: { surface: 'onboarding_capture_inline', has_task: currentTask.trim() ? 1 : 0 },
      });
    } catch (err) {
      // Free plan caps projects at 1. If they already have one there is nothing to
      // seed — treat it as done rather than blocking them behind an upgrade wall
      // during setup.
      if (isApiError(err) && err.status === 422) {
        setSeeded(true);
      } else {
        setSaveError('Could not save that just now. You can also seed it from your tool with the prompt below.');
      }
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    trackProductEvent('onboarding_capture_viewed', { source: 'dashboard', path: '/onboarding' });
  }, []);

  useEffect(() => {
    if (briefed && !firedBriefed.current) {
      firedBriefed.current = true;
      trackProductEvent('onboarding_first_brief_detected', { source: 'dashboard', path: '/onboarding' });
    }
  }, [briefed]);

  return (
    <div className="min-h-screen bg-background text-text-primary">
      <div className="relative mx-auto flex min-h-screen max-w-2xl items-center px-6 py-12 lg:px-10">
        <div className="w-full">
          <section className="rounded-[32px] border border-border-subtle bg-overlay-subtle p-8 shadow-[0_30px_90px_rgba(0,0,0,0.24)] max-sm:rounded-3xl max-sm:p-6 lg:p-10">
            <StepRail current="capture" done={['connect']} />
            <div className="dashboard-eyebrow">Step 2 · Your first brief</div>
            <h1 className="mt-3 text-[clamp(2rem,4vw,3rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-text-primary">
              Write your first brief.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-7 text-text-secondary">
              {captureFirst
                // Capture-first runs before anything is connected, so it cannot
                // tell the user to "start a chat in your tool" — there is no tool
                // yet. It promises the payoff instead, and connecting comes next.
                ? 'Start here — this works on your phone. Tell us what you’re working on and it becomes your first brief. Connect an AI tool next, on whatever device you use it, and its very next session opens with this.'
                : 'Nothing to read yet — that’s expected. Something has to be written before a session can open briefed. Tell us what you’re working on below and that becomes your first brief, or have your AI write it. Every session after opens already caught up.'}
            </p>

            {/* Live status — flips to a celebration when the first brief lands. */}
            <div className={`mt-6 flex items-start gap-3 rounded-2xl border p-4 ${briefed ? 'border-primary/30 bg-primary/[0.07]' : 'border-border-subtle bg-overlay-subtle'}`}>
              {briefed ? (
                <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-on-primary">✓</span>
              ) : (
                <span className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-primary" />
              )}
              <div className="text-sm leading-6">
                {briefed ? (
                  <>
                    <span className="font-semibold text-text-primary">Your first brief just landed.</span>
                    <span className="text-text-secondary"> Every new session opens already briefed — it&apos;s waiting on your dashboard.</span>
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-text-primary">Waiting for your first brief…</span>
                    <span className="text-text-secondary">
                      {captureFirst
                        ? ' Fill in the two fields below — that is all it takes.'
                        : ' Start a chat in your tool and tell it what you’re working on. This updates automatically.'}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* PRIMARY path: write the first brief here, in two fields, without
                leaving. Previously the only way through this step was to switch to
                another app and paste a prompt — the exact kind of off-site detour
                that loses people mid-setup. The prompt route is kept below for
                anyone who would rather have their AI do it. */}
            {!briefed && (
              <div className="mt-4 rounded-2xl border border-primary/30 bg-primary/[0.08] p-4">
                <div className="text-sm font-semibold text-text-primary">Write it here — takes about 20 seconds</div>
                <p className="mt-1 text-[13px] leading-6 text-text-secondary">
                  Two lines is enough. This becomes the brief your next session opens with.
                </p>
                <div className="mt-3 flex flex-col gap-2.5">
                  <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveFirstBrief(); }}
                    placeholder="What are you working on? (e.g. Checkout redesign)"
                    aria-label="Project name"
                    className="ui-focus w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
                  />
                  <input
                    value={currentTask}
                    onChange={(e) => setCurrentTask(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveFirstBrief(); }}
                    placeholder="Where are you right now? (optional)"
                    aria-label="Current task"
                    className="ui-focus w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
                  />
                  <div>
                    <Button onClick={saveFirstBrief} disabled={!projectName.trim()} isLoading={saving}>
                      Save my first brief
                    </Button>
                  </div>
                  {saveError && (
                    <span className="text-xs text-status-danger">{saveError}</span>
                  )}
                </div>
              </div>
            )}

            {/* Alternative: let their AI write it instead — better context, but it
                means leaving the page, so it is no longer the only option.

                Hidden on capture-first: it says "paste this into your tool", and
                on that ordering there is no connected tool yet. Offering it here
                would send a phone user to the one action this ordering exists to
                stop putting first. It reappears on the connect step that follows. */}
            {/* These two copies are PROMPTS, not connector configs. They emitted
                mcp_config_copied until 2026-09-16, which productAnalytics maps
                to the Google Ads "connect attempted" conversion, so copying a
                prompt to write a first brief was bid on as a connection. They
                now have their own event. */}
            {!captureFirst && (
            <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/[0.05] p-4">
              <div className="text-sm font-semibold text-text-primary">Or let your AI write it</div>
              <p className="mt-1 text-[13px] leading-6 text-text-secondary">Paste this into your tool and answer — it saves your first brief on the spot:</p>
              <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-[var(--code-bg)] p-2.5">
                <code className="break-all font-mono text-xs text-text-secondary">{FIRST_BRIEF_PROMPT}</code>
                <CopyButton
                  text={FIRST_BRIEF_PROMPT}
                  label="Copy"
                  onCopy={() => trackProductEvent('onboarding_prompt_copied', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_first_brief', via: 'brief_prompt' } })}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <CopyButton
                  text={CLAUDE_AI_SYSTEM_PROMPT}
                  label="Copy ‘make it automatic’ prompt"
                  onCopy={() => trackProductEvent('onboarding_prompt_copied', { source: 'dashboard', path: '/onboarding', metadata: { surface: 'onboarding_automate', via: 'automation_prompt' } })}
                />
                <span className="text-[11px] leading-5 text-text-muted">Drop into your tool’s custom instructions so it briefs itself every session.</span>
              </div>
            </div>
            )}

            {/* GATED on a real brief existing. A brand-new account has nothing saved,
                so start_session returns an empty (suppressed) injection and emits no
                context_delivered — the user has connected but received zero value.
                Seeding context here is what makes their NEXT session open briefed,
                which is the actual product promise. Verified in prod: one user
                completed 5 MCP handshakes and 2 start_session calls and still had 0
                briefs delivered, because nothing had ever been written. */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button onClick={() => onContinue(hasFirstSync)} disabled={!briefed}>
                {briefed
                  ? (captureFirst ? 'Saved — next: connect your AI →' : 'Continue →')
                  : 'Waiting for your first brief…'}
              </Button>
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  className="ui-focus rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={onExitEarly}
                className="ui-focus rounded-xl px-3 py-2.5 text-sm font-medium text-text-muted transition-colors hover:text-text-secondary"
              >
                I&apos;ll finish this later
              </button>
            </div>
            {!briefed && (
              <p className="mt-3 text-xs text-text-muted">
                {captureFirst
                  ? 'Save a brief above — it takes one line, and it is what your AI reads the moment you connect it.'
                  : 'Save a brief above, or paste the prompt into your connected tool — this unlocks the moment your first brief exists.'}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Survey (asked AFTER connect) ────────────────────────────────────────────
// "Why are you using DeerDawn" questionnaire. Values must match the allowed sets
// in apps/api/src/routes/shared/onboarding.js. Single-select for low friction,
// plus one free-text question to build commitment.
const SURVEY_TOOLS: { value: string; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex' },
  { value: 'other', label: 'Other' },
];

function OptionChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ui-press ui-focus rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-primary/50 bg-primary/15 text-primary'
          : 'border-border-subtle bg-overlay-subtle text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

function OnboardingSurvey({ onDone }: { onDone: () => void }) {
  const [tools, setTools] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    trackProductEvent('onboarding_survey_viewed', { source: 'dashboard', path: '/onboarding' });
  }, []);

  const toggleTool = (value: string) => {
    setTools((current) => current.includes(value) ? current.filter((t) => t !== value) : [...current, value]);
  };

  const finish = async (skipped: boolean) => {
    setSaving(true);
    setError(null);
    try {
      if (!skipped) {
        await api.saveOnboardingSurvey({ tools });
      }
      trackProductEvent(skipped ? 'onboarding_survey_skipped' : 'onboarding_survey_submitted', {
        source: 'dashboard',
        path: '/onboarding',
        metadata: { answered: tools.length ? 1 : 0, tools_count: tools.length },
      });
      onDone();
    } catch {
      // Saving the survey should never block onboarding — let the user continue.
      setError('We could not save your answers, but you can keep going.');
      trackProductEvent('onboarding_survey_save_failed', { source: 'dashboard', path: '/onboarding' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-text-primary">
      <div className="relative mx-auto flex min-h-screen max-w-2xl items-center px-6 py-12 lg:px-10">
        <div className="w-full">
          <section className="rounded-[32px] border border-border-subtle bg-overlay-subtle p-8 shadow-[0_30px_90px_rgba(0,0,0,0.24)] max-sm:rounded-3xl max-sm:p-6 lg:p-10">
            <StepRail current="personalize" done={['connect', 'capture']} />
            <div className="dashboard-eyebrow">Step 3 · Personalize</div>
            <h1 className="mt-3 text-[clamp(2rem,4vw,3rem)] font-semibold leading-[0.96] tracking-[-0.05em] text-text-primary">
              Help us tailor DeerDawn to you.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-7 text-text-secondary">
              Last step. One quick question so we can point you at the right next step.
            </p>

            {error ? (
              <p className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-sm text-text-secondary">{error}</p>
            ) : null}

            <div className="mt-8">
              <div className="text-sm font-semibold text-text-primary">Which AI tools do you use?</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {SURVEY_TOOLS.map((opt) => (
                  <OptionChip key={opt.value} active={tools.includes(opt.value)} onClick={() => toggleTool(opt.value)}>
                    {opt.label}
                  </OptionChip>
                ))}
              </div>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button onClick={() => finish(false)} isLoading={saving}>Continue</Button>
              <button
                type="button"
                onClick={() => finish(true)}
                disabled={saving}
                className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                Skip
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Flow: connect a tool → capture first brief → personalize ────────────────
// Connect-first sequencing (2026-07): connecting a tool is the only action that
// actually activates a user (the first context sync), so it's the very first
// thing they hit. The "capture" step reframes the empty-context dead-end into
// the productive first move — your first session WRITES the brief. Users who
// want to import context can still do it any time from the dashboard
// (/context/import).
//
// ON MOBILE THAT ORDER IS INVERTED (2026-08-14), because connecting is the one
// thing a phone cannot reliably do. Measured over the 30 days to 2026-08-14:
// 16 of 32 real signups were on mobile (14 of them from the Google Ads
// phase_1_high_intent campaign), 15 reached onboarding, 7 picked a setup path,
// 5 copied the URL, and ZERO ever started a runtime. Leading a phone user with
// "wire an MCP server into your desktop tool" opens their account with the only
// task they cannot complete, and 2 of 32 signups ever returned on a later day —
// so "finish it later at a computer" is not a real plan, it is the end.
//
// Capture-first gives them an action a phone is good at: two text fields and a
// server-side project create. It is not a consolation prize — it is the step
// that makes activation possible at all. contextSyncService only emits
// context_delivered on a NON-suppressed injection, so an account with nothing
// written is one whose first start_session delivers an empty brief and records
// nothing. Seeding first means whenever the connection does happen, from
// whatever device, the very next session opens briefed.
type Phase = 'loading' | 'connect' | 'capture' | 'survey';

// ── Before there is an account ───────────────────────────────────────────────
//
// What a signed-out reader sees at /onboarding, instead of a bounce to /login.
//
// The public /connect page hands the connector URL and the setup command to
// anyone; this page — the dashboard's own version of the same instructions —
// asked for an account first. So the two strings that are IDENTICAL for every
// user sat behind a signup form, and 25 of 55 accounts in the measured window
// abandoned that form. Neither value is account-scoped (see
// `src/lib/onboardingPreview.ts` for why, at length), so there is nothing here
// to leak and nothing that turns out to be wrong once you sign in.
//
// Two rules this screen keeps:
//
//  1. REAL VALUES ONLY. Everything copyable comes from `connectCopy.ts`, the
//     same module the signed-in step renders from. No sample, no placeholder,
//     nothing that has to be re-copied later — a fake URL is worse than none,
//     because the reader cannot tell which of the two they are holding.
//  2. SAY WHERE IT STOPS. The paste cannot finish the job: the tool opens a
//     DeerDawn tab to authorize, and that step needs an account. That is stated
//     up front rather than discovered at an authorization screen.
//
// It issues no authenticated request, which is the condition AuthProvider's
// PREVIEW_PAGES list is granted on.
function SignedOutSetupPreview() {
  useEffect(() => {
    // Client-side PostHog, not trackProductEvent, and a deliberately separate
    // event name — for the same reasons marketing's /connect page uses
    // `connect_setup_copied`. Folding an anonymous view into `mcp_setup_viewed`
    // would re-baseline every insight already counting the signed-in step, and
    // routing it through the product-events API would mint a server-side person
    // per anonymous visitor with no `is_test` to filter on. Copies here also
    // stay OUT of `mcp_config_copied`, which maps to a Google Ads "connect
    // attempted" conversion that should not fire before there is an account.
    phCapture('connect_setup_viewed', { surface: 'dashboard_onboarding_signed_out' });
  }, []);

  const trackCopy = (method: string) =>
    phCapture('connect_setup_copied', { method, surface: 'dashboard_onboarding_signed_out' });

  return (
    <div className="min-h-screen bg-background text-text-primary">
      <div className="relative mx-auto flex min-h-screen max-w-3xl items-center px-6 py-12 max-sm:py-6 lg:px-10">
        <div className="w-full">
          <section className="rounded-[32px] border border-border-subtle bg-overlay-subtle p-8 shadow-[0_30px_90px_rgba(0,0,0,0.24)] max-sm:rounded-3xl max-sm:p-6 lg:p-10">
            <div className="dashboard-eyebrow">Setup, before you sign up</div>
            <h1 className="mt-3 text-[clamp(2rem,4.6vw,3.2rem)] font-semibold leading-[0.96] tracking-[-0.06em] text-text-primary max-sm:mt-2 max-sm:text-[1.75rem]">
              Here is exactly what you paste.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-7 text-text-secondary max-sm:mt-2.5 max-sm:text-[14px] max-sm:leading-6">
              Nothing below is specific to an account. One hosted URL, or one command — the same for
              every DeerDawn user, and the same strings this page shows after you sign in.
            </p>

            <div className="mt-8 space-y-3">
              {PREVIEW_SETUP.map((item) => (
                <div key={item.id} className="rounded-[20px] border border-border-subtle bg-surface p-5 max-sm:p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                    {item.label}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="break-all text-xs text-primary">{item.value}</code>
                    <CopyButton text={item.value} onCopy={() => trackCopy(item.id)} />
                  </div>
                  <p className="mt-2 text-[13px] leading-6 text-text-secondary">{item.detail}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-[20px] border border-border-subtle bg-surface p-5 max-sm:p-4">
              <div className="text-base font-semibold text-text-primary">Where it goes in your tool</div>
              <dl className="mt-3 space-y-2">
                {PREVIEW_LOCATIONS.map((location) => (
                  <div key={location.tool} className="flex flex-wrap gap-x-3 gap-y-0.5 text-[13px] leading-6">
                    <dt className="min-w-[9rem] font-medium text-text-primary max-sm:min-w-0">{location.tool}</dt>
                    <dd className="min-w-0 flex-1 text-text-secondary">{location.where}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* The honest stopping point. Pasting the URL gets the reader to an
                authorization screen and no further, so the account is named as
                the reason rather than presented as a gate they walked into. */}
            <div className="mt-6 rounded-[20px] border border-primary/30 bg-primary/[0.08] p-5 max-sm:p-4">
              <div className="text-base font-semibold text-text-primary">What signing in adds</div>
              <div className="mt-3 space-y-3">
                {WHAT_SIGNING_IN_ADDS.map((line, index) => (
                  <StepRow key={line} num={index + 1}>{line}</StepRow>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2.5">
                <Link
                  href={PREVIEW_SIGNUP_ROUTE}
                  className="ui-press ui-focus inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-on-primary no-underline transition-colors hover:bg-primary/90"
                >
                  Create a free account
                </Link>
                <Link
                  href={PREVIEW_SIGNIN_ROUTE}
                  className="text-[13px] font-medium text-text-secondary no-underline underline-offset-4 transition-colors hover:text-text-primary hover:underline"
                >
                  or sign in
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Reports what happened to the briefs a visitor built before signing up.
 *
 * The failure copy is the point of this component. A stash can be gone for
 * mundane reasons, and the tempting thing is to say nothing — the user got
 * their account, the flow continues, no error was thrown. But they were told
 * their briefs would come with them, so silence here is a small lie. It says
 * what was lost and what to do instead.
 */
function BriefStashToast({
  state,
  onDismiss,
}: {
  state: { status: 'idle' | 'claiming' } | { status: 'done'; names: string[] } | { status: 'expired' | 'error' };
  onDismiss: () => void;
}) {
  if (state.status === 'idle') return null;

  const tone =
    state.status === 'done' ? 'border-primary/30 bg-primary/10' : 'border-border-strong bg-overlay-strong';

  let message: string;
  if (state.status === 'claiming') {
    message = 'Bringing your briefs across…';
  } else if (state.status === 'done') {
    const { names } = state;
    if (names.length === 0) {
      message = 'Your briefs could not be imported. You can rebuild them from any project page.';
    } else if (names.length === 1) {
      message = `Imported ${names[0]}. It is in your projects now.`;
    } else {
      message = `Imported ${names.length} projects: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}.`;
    }
  } else if (state.status === 'expired') {
    message = 'Those briefs expired before you finished signing up — they are kept for an hour. Your account is fine; you can build them again in a moment.';
  } else {
    message = 'We could not import those briefs. Your account is fine, and nothing else was affected.';
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-auto flex max-w-xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm text-text-secondary shadow-[0_20px_60px_rgba(0,0,0,0.28)] ${tone}`}
      >
        <span className="leading-6">{message}</span>
        {state.status !== 'claiming' && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-lg px-2 py-0.5 text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

export default function Onboarding() {
  // Renders outside the dashboard shell, whose global `overflow: hidden`
  // would otherwise make everything below the fold unreachable.
  usePageScroll();
  // Resolved by AuthProvider, which holds this page behind its loading screen
  // until Clerk answers — so this is settled on the first render and there is no
  // frame where a signed-in user sees the signed-out screen or the reverse. It
  // is 'signed-in' by default in deployments with no Clerk (local dev,
  // self-hosted), where AuthProvider is not mounted at all and the flow below is
  // the only thing that should run.
  const presence = useAuthPresence();
  const signedOut = presence === 'signed-out';
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  // Whether the user already answered the survey on a previous visit — used only
  // to SKIP the survey, never to gate any step.
  const surveyDoneRef = useRef(false);
  // Drives the capture-first ordering. Pinned once, when the flow actually
  // starts: reading it live would let a tablet rotation or a desktop window drag
  // re-order the steps mid-flow, sending the user back to a screen they had
  // already finished.
  //
  // Held twice on purpose. The ref is for the step callbacks, which are created
  // once and would otherwise close over a stale ordering; the state is for
  // render, which must subscribe to the value rather than read a ref that React
  // is not tracking. Both are written together in start() below and never again,
  // so they cannot disagree.
  const mobileFirst = useRef(false);
  const [captureFirst, setCaptureFirst] = useState(false);

  useEffect(() => {
    // The one authenticated call this page makes on mount, and the reason a
    // signed-out reader must never reach it: with no token it 401s, and the
    // `.catch(start)` below would then walk them into the authed flow, which is
    // precisely the "confusing session expired error" the original gate on this
    // route existed to prevent. The preview replaces the flow, it does not run
    // alongside it.
    if (signedOut) return;
    let active = true;
    const start = () => {
      if (!active) return;
      // Read the viewport HERE, not from this effect's closure.
      //
      // This used to close over `useIsMobile()`, with the note that awaiting the
      // survey lookup gave the hook time to "settle". It does not: the hook is
      // false in the first render on every device (the server has no viewport,
      // so the hydration render has to agree with it), and the later flip
      // produces a NEW closure while this one keeps the original `false`. The
      // delay never mattered. Every phone user was pinned to `connect_first`
      // for the entire life of the feature — 18 of 18 real users reaching
      // onboarding between 2026-08-16 and 2026-08-25 saw the connect step
      // before the capture step, 10 of them on mobile, none capture-first.
      //
      // isMobileNow() reads matchMedia directly, which is safe because this only
      // ever runs on the client, after mount.
      const mobileFirstNow = isMobileNow();
      mobileFirst.current = mobileFirstNow;
      setCaptureFirst(mobileFirstNow);
      setPhase(mobileFirstNow ? 'capture' : 'connect');
    };
    api.getOnboardingSurvey()
      .then((r) => { if (active) { surveyDoneRef.current = Boolean(r.completed); start(); } })
      .catch(start);
    return () => { active = false; };
    // `signedOut` is the only dep, and it is settled before this component ever
    // mounts (AuthProvider holds the page until Clerk answers), so it cannot
    // flip mid-flow. The viewport is still read inside start() rather than
    // captured, so there is no stale value to re-synchronise: re-running on a
    // breakpoint flip would restart the flow underneath someone partway through
    // it, which is what pinning exists to prevent.
  }, [signedOut]);

  // Briefs the user built anonymously at deerdawn.com/tools/context-preview,
  // parked server-side and carried here as an opaque `?stash=` token because
  // marketing and the app are different origins.
  //
  // Rendered as a toast rather than a step: the phase machine below is tuned
  // and ordered deliberately, and an import that succeeded does not need to
  // interrupt it. An import that FAILED does need to be said out loud, which is
  // why 'expired' is a state here and not a silent return.
  const [stashState, setStashState] = useState<
    { status: 'idle' | 'claiming' } | { status: 'done'; names: string[] } | { status: 'expired' | 'error' }
  >({ status: 'idle' });

  useEffect(() => {
    if (signedOut || !router.isReady) return;
    const token = router.query.stash;
    if (typeof token !== 'string' || !token) return;

    let active = true;
    setStashState({ status: 'claiming' });

    // Strip the token from the URL immediately. It is single-use, and leaving it
    // in the address bar means a refresh re-fires a claim that can only fail.
    const rest = { ...router.query };
    delete rest.stash;
    router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });

    api.claimBriefStash(token)
      .then((result) => {
        if (!active) return;
        setStashState({ status: 'done', names: result.claimed.map((c) => c.project_name) });
        trackProductEvent('brief_stash_claimed', {
          source: 'dashboard',
          path: '/onboarding',
          metadata: { claimed: result.claimed_count, failed: result.failed.length },
        });
      })
      .catch((err) => {
        if (!active) return;
        // 410 is the honest "those briefs are gone" case — expired, already
        // claimed, or a token that never existed. Anything else is a fault.
        const expired = isApiError(err) && err.status === 410;
        setStashState({ status: expired ? 'expired' : 'error' });
        trackProductEvent('brief_stash_claim_failed', {
          source: 'dashboard',
          path: '/onboarding',
          metadata: { reason: expired ? 'expired' : 'error' },
        });
      });

    return () => { active = false; };
    // router.query is read once per arrival; re-running on every router change
    // would re-fire the claim against a token we just stripped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedOut, router.isReady]);

  // Whether the connect step saw a server-verified MCP handshake. Carried to
  // finishOnboarding so onboarding_completed keeps telling the truth now that the
  // Continue button no longer blocks on it — the honesty moved from the button
  // into this flag rather than being dropped.
  const [connectionVerified, setConnectionVerified] = useState(false);

  // Whether the capture step saw the server's durable first_sync_completed.
  // Reported on onboarding_completed so the funnel can tell a completion that
  // actually activated from one that only walked the screens.
  const [firstSyncConfirmed, setFirstSyncConfirmed] = useState(false);

  // True terminal exit: fires onboarding_completed with elapsed time (from
  // markOnboardingStart), then hands off to plan selection. Reached after the
  // capture step (+ survey when not already answered). verified_connection now
  // reports what actually happened instead of asserting true, so a completion
  // that rode an unverified connection is still visible in the funnel.
  const finishOnboarding = (exit: string, activated = firstSyncConfirmed) => {
    trackOnboardingCompletion({
      surface: 'onboarding_flow',
      flow: mobileFirst.current ? 'capture_first' : 'connect_first',
      exit,
      verified_connection: connectionVerified,
      first_sync: activated,
    });
    router.push('/select-plan');
  };

  // Leaving before setup is finished.
  //
  // Used to route to /select-plan, same as a real finish. That inverted the
  // whole point of putting plan selection AFTER onboarding: the people it showed
  // pricing to were exactly the ones who had received no value yet. PostHog shows
  // onboarding_exited_early firing 0.2-1.8s before select_plan_viewed in every
  // case checked — 11 of 29 signups over 30 days went straight from "I'll finish
  // this later" to a paywall, having never connected anything.
  //
  // Now routes to the dashboard ('/', Today), whose own first-run hero — "Nothing
  // to pick up yet" — links straight back here, and whose connection strip offers
  // "Connect a tool" while no surface has called in. Nothing is lost: /select-plan's
  // only side effect is a best-effort updateAccountType, free is the default tier,
  // and its own dismiss path already lands on '/'.
  //
  // This used to credit a dashboard OnboardingChecklist component with the pick-up.
  // That component stopped being rendered anywhere well before the 2026-08-27 Today
  // redesign and was deleted; Today's hero is what actually catches these users. The
  // claim survived because every contract test here reads source as TEXT — see
  // tests/render-tree-contract.test.js, which now fails when a component leaves the
  // render tree.
  const exitEarly = (step: string) => {
    trackProductEvent('onboarding_exited_early', {
      source: 'dashboard',
      path: '/onboarding',
      metadata: { step, surface: 'onboarding_flow', verified_connection: connectionVerified },
    });
    router.push('/');
  };

  // Ahead of the phase machine, which is about WHICH step of the flow to show
  // and presupposes an account to run it against. `phase` stays 'loading'
  // forever for a signed-out reader, because the effect that advances it is the
  // authed call that is deliberately not made.
  if (signedOut) {
    return <SignedOutSetupPreview />;
  }

  // Wraps whichever step the phase machine renders, so the import result rides
  // along without any step needing to know about it.
  const withStashToast = (node: React.ReactNode) => (
    <>
      <BriefStashToast state={stashState} onDismiss={() => setStashState({ status: 'idle' })} />
      {node}
    </>
  );

  if (phase === 'loading') {
    return withStashToast(<div className="min-h-screen bg-background" />);
  }
  // `flow` rides on every step event so the two orderings never average together
  // in the funnel — a mobile capture-first completion and a desktop connect-first
  // one mean different things and must be compared separately.
  const flow = captureFirst ? 'capture_first' : 'connect_first';

  if (phase === 'connect') {
    return withStashToast(<ConnectStep
      onExitEarly={() => exitEarly('connect')}
      onContinue={(verified: boolean) => {
        setConnectionVerified(verified);
        trackProductEvent('onboarding_step_completed', { source: 'dashboard', path: '/onboarding', metadata: { step: 'connect', surface: 'onboarding_flow', flow, verified_connection: verified } });
        // Capture-first: connect is the LAST step, so continuing from it finishes
        // onboarding rather than advancing into a capture step already done.
        if (mobileFirst.current) {
          if (surveyDoneRef.current) finishOnboarding('connect');
          else setPhase('survey');
          return;
        }
        setPhase('capture');
      }}
    />);
  }
  if (phase === 'capture') {
    return withStashToast(<CaptureStep
      // Capture-first has nothing behind it — offering Back would walk the user
      // out of the flow's first screen.
      onBack={captureFirst ? undefined : () => setPhase('connect')}
      captureFirst={captureFirst}
      onExitEarly={() => exitEarly('capture')}
      onContinue={(activated: boolean) => {
        setFirstSyncConfirmed(activated);
        trackProductEvent('onboarding_step_completed', { source: 'dashboard', path: '/onboarding', metadata: { step: 'capture', surface: 'onboarding_flow', flow, first_sync: activated } });
        // Capture-first: connecting still has to happen, it just happens second,
        // once the account already holds a brief worth delivering.
        if (mobileFirst.current) { setPhase('connect'); return; }
        if (surveyDoneRef.current) finishOnboarding('capture', activated);
        else setPhase('survey');
      }}
    />);
  }
  return withStashToast(<OnboardingSurvey onDone={() => {
    trackProductEvent('onboarding_step_completed', { source: 'dashboard', path: '/onboarding', metadata: { step: 'survey', surface: 'onboarding_flow', flow } });
    finishOnboarding('survey');
  }} />);
}

export async function getServerSideProps() {
  return { props: {} };
}
