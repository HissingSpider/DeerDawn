/**
 * Onboarding activation contracts (2026-08-12).
 *
 * The connect step is where activation dies. Two properties are pinned here
 * because both were introduced with good intentions and both cost activation:
 *
 *   1. The Continue button was `disabled={status === 'waiting'}` — gated on
 *      DeerDawn server-DETECTING an MCP handshake. Detection fired for one
 *      person in 30 days, so the button was permanently dead and the only
 *      enabled control on the page was "I'll finish this later".
 *
 *   2. That escape hatch routed to /select-plan — a paywall. So the people shown
 *      pricing were exactly the ones who had received no value yet.
 *      onboarding_exited_early fires 0.2-1.8s before select_plan_viewed in every
 *      observed case; 11 of 29 signups took that path within 17-80 seconds.
 *
 * Funnel it produced: 29 reached this step, 9 picked a tool, 2 ever started a
 * runtime, 1 authorized.
 *
 * Run: `node tests/onboarding-activation-contract.test.js` (wired into
 * `npm test -w dashboard`).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const onboarding = fs.readFileSync(path.join(root, 'src/pages/onboarding.tsx'), 'utf8');
const connectCopy = fs.readFileSync(path.join(root, 'src/lib/connectCopy.ts'), 'utf8');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('=== Onboarding Activation Contracts ===\n');

// The desktop Continue button, isolated from the mobile one above it.
const desktopContinue = onboarding.slice(
  onboarding.indexOf("markResolved('continued');"),
  onboarding.indexOf("I&apos;ll finish this later", onboarding.indexOf("markResolved('continued');"))
);

test('the connect step never blocks forward motion on connection detection', () => {
  assert.ok(desktopContinue.length > 0, 'desktop Continue button not found');
  assert.ok(
    !/disabled=\{status === 'waiting'\}/.test(desktopContinue),
    "the Continue button must not be disabled while waiting — detection lags a working " +
      'connection, and gating on it left "I\'ll finish this later" as the only live control'
  );
});

test('continuing reports whether the connection was actually verified', () => {
  assert.ok(
    /onContinue\(status !== 'waiting'\)/.test(desktopContinue),
    'Continue must pass the real verification state so the honesty lives in the event, ' +
      'not in a dead button'
  );
  assert.ok(
    /verified_connection: connectionVerified/.test(onboarding),
    'onboarding_completed must report the observed connection state, never a hardcoded true'
  );
});

test('bailing out of setup does not land the user on a paywall', () => {
  const exitEarly = onboarding.slice(
    onboarding.indexOf('const exitEarly = (step: string) => {'),
    onboarding.indexOf('if (phase === ', onboarding.indexOf('const exitEarly = (step: string) => {'))
  );
  assert.ok(exitEarly.length > 0, 'exitEarly not found');
  assert.ok(
    !/router\.push\('\/select-plan'\)/.test(exitEarly),
    'exitEarly must not route to /select-plan — plan selection is meant to follow ' +
      'value, and someone abandoning setup has received none'
  );
  assert.ok(
    /router\.push\('\/'\)/.test(exitEarly),
    "exitEarly should drop the user into the dashboard ('/', Today), whose own " +
      'first-run hero links back into this flow'
  );
});

test('a real, verified finish still routes to plan selection', () => {
  const finish = onboarding.slice(
    onboarding.indexOf('const finishOnboarding = (exit: string'),
    onboarding.indexOf('const [connectionVerified') > onboarding.indexOf('const finishOnboarding')
      ? onboarding.length
      : onboarding.indexOf('// Leaving before setup is finished')
  );
  assert.ok(
    /router\.push\('\/select-plan'\)/.test(finish),
    'value-first ordering is intact: a genuine completion still hands off to plan selection'
  );
});

console.log('\nOnboarding activation contracts in place.');

test('onboarding completion is gated on the durable first-sync signal, not a client poll', () => {
  // The gate. `briefed` decides whether the capture step's Continue is
  // enabled, i.e. whether a user can ever reach onboarding_completed.
  //
  // This used to pin the exact literal `hasFirstSync || seeded`, which made it
  // fail on the fix for a defect it was never about: with only those two, "Or
  // let your AI write it" was an offer nobody could accept, because
  // first_sync_completed is emitted on context DELIVERY and an AI that writes a
  // brief without reading one back never produces it. `hasBrief` (has_projects)
  // is the same server-confirmed standard `seeded` already used, for a project
  // this page did not create — see tests/capture-step-unlock-contract.test.js.
  //
  // So assert what this test's own title says instead: every term is
  // server-confirmed, and none of them is the connection poll.
  const briefedExpr = onboarding.match(/const briefed = ([^;]+);/);
  assert(briefedExpr, '`briefed` is no longer computed in the capture step');
  const terms = briefedExpr[1].split('||').map((t) => t.trim());
  const SERVER_CONFIRMED = ['hasFirstSync', 'seeded', 'hasBrief'];
  for (const term of terms) {
    assert(
      SERVER_CONFIRMED.includes(term),
      `\`briefed\` gained the term "${term}". Every term must be server-confirmed: ` +
        `${SERVER_CONFIRMED.join(', ')}. A client-side or self-attested signal here ` +
        'lets someone complete onboarding on something we never observed.'
    );
  }
  assert(
    terms.includes('hasFirstSync'),
    'the durable first-sync signal must remain one of the terms'
  );
  assert(
    !/\bstatus\b|\bevidence\b/.test(briefedExpr[1]),
    "capture step regressed to the in-page connection poll — status === 'synced' only " +
      'sees syncs that land while the tab is open, and whether a tool is connected is a ' +
      'different question from whether a brief exists'
  );
  // The flag has to come from sync_health, which is server-side and durable.
  assert(
    onboarding.includes('data.sync_health?.has_first_sync'),
    'connection hook should read sync_health.has_first_sync'
  );
  // And the completion event has to report whether it actually activated, plus
  // which of the two completion surfaces it came from.
  // Matched field-by-field rather than as one literal call: the argument is now
  // multi-line and carries `flow`, and pinning the exact formatting made this
  // assertion fail on a reformat that changed no behavior.
  const completionCall = onboarding.slice(
    onboarding.indexOf('trackOnboardingCompletion({'),
    onboarding.indexOf('trackOnboardingCompletion({') + 400
  );
  for (const field of ["surface: 'onboarding_flow'", 'verified_connection: connectionVerified', 'first_sync: activated']) {
    assert(
      completionCall.includes(field),
      `onboarding_completed should carry ${field} so a completion that never activated is visible`
    );
  }
});

test('every onboarding_completed emitter labels its surface', () => {
  // onboarding_step_completed already carries this discriminator; onboarding_completed
  // did not, so the /onboarding flow and the dashboard checklist were indistinguishable
  // in the funnel and their very different duration_ms values averaged together.
  //
  // The second emitter is gone: OnboardingChecklist (surface 'dashboard_checklist')
  // was deleted once it turned out nothing had rendered it in months. This test used
  // to read that component's SOURCE TEXT, which is precisely why its death went
  // unnoticed — a file on disk satisfied the assertion whether or not anything
  // mounted it. Reachability is now pinned in tests/render-tree-contract.test.js.
  //
  // 'dashboard_checklist' deliberately stays in the union below: it labels real
  // events already in PostHog, and dropping it would make that history unreadable.
  const emitters = onboarding.match(/trackOnboardingCompletion\(\{/g) || [];
  assert(emitters.length > 0, 'the onboarding flow must still emit onboarding_completed');
  assert(
    /trackOnboardingCompletion\(\{\s*surface: 'onboarding_flow'/.test(onboarding),
    'the onboarding flow completion should identify its surface'
  );
  // Required at the type level so a third completion path cannot skip it.
  const analytics = fs.readFileSync(path.join(root, 'src/lib/productAnalytics.ts'), 'utf8');
  assert(
    /surface: 'onboarding_flow' \| 'dashboard_checklist'/.test(analytics),
    'trackOnboardingCompletion should require a surface'
  );
});

test('picking a tool visibly changes the page, and browsing is not counted as choosing', () => {
  // The thrash: PostHog showed one person cycling 6 tools in 10s and another 5
  // in 3s (147ms apart at the tightest). Every tool but Claude Code shows the
  // same URL and near-identical steps, and on a phone that block is below the
  // fold — so a tap changed nothing the user could see and they tapped again.
  assert.ok(
    onboarding.includes('toolStepsRef.current?.scrollIntoView('),
    'picking a tool should scroll its instructions into view so the tap is visibly consequential'
  );
  assert.ok(
    onboarding.includes('if (!didMountTool.current)'),
    'the scroll must run from an effect (after React commits) and skip first paint, not from the click handler'
  );
  assert.ok(
    onboarding.includes('Setting up {selectedTool}'),
    'the instruction panel should name the selected tool so the change is unmistakable'
  );

  // Funnel honesty: 12 people produced 31 setup_path_selected events, which read
  // as 31 setup starts. Only the first pick is the funnel step now.
  assert.ok(
    onboarding.includes('if (!pathChosen.current)') && onboarding.includes("'setup_path_changed'"),
    'only the first tool pick should emit setup_path_selected; later picks are setup_path_changed'
  );
});

test('a phone is never handed a disabled button as its only path forward', () => {
  // #288 removed `disabled={status === 'waiting'}` from the desktop Continue and
  // moved the honesty into verified_connection on the event. The mobile card kept
  // the gate — on the half of traffic that cannot satisfy it. Over the 30 days to
  // 2026-08-14: 16 of 32 real signups were mobile, 15 reached onboarding, 5 copied
  // the URL, ZERO started a runtime, and 2 of 32 signups ever returned on a later
  // day. The mobile Continue must stay enabled for the same reason the desktop one
  // does.
  const mobileCard = onboarding.slice(
    onboarding.indexOf('continued_mobile') - 1200,
    onboarding.indexOf('continued_mobile') + 400
  );
  assert(
    !/disabled=\{status === 'waiting'\}/.test(mobileCard),
    'the mobile Continue must not be gated on connection detection'
  );
});

test('the phone card offers the desktop setup link to every mobile user', () => {
  // #250 (2026-08-04) rephrased this button from "Email me the desktop setup
  // link" to "Using Cursor or Codex? Email me the desktop link". Nothing gated
  // it in code, but the qualifier names two tools while the card's own default
  // is Claude.ai, so a phone user on Claude reads the first three words and
  // opts out of an offer that was meant for them.
  //
  // Weekly mobile people reaching this step vs requests: 10 -> 3, rephrase
  // lands, 8 -> 1, 8 -> 0, 9 -> 0. Traffic flat, uptake to zero, still zero
  // three weeks later. Wanting to finish at a computer is a being-on-a-phone
  // problem, not a Cursor-and-Codex one.
  assert(
    /'Email me the desktop setup link'/.test(onboarding),
    'the phone card should offer the desktop link in universal terms'
  );
  assert(
    !/Using Cursor or Codex\? Email me the desktop link/.test(onboarding),
    'the desktop-link offer regressed to a tool-qualified label that mobile Claude users opt out of'
  );
  // The tool-specific version still belongs at the wall it rescues people from,
  // and the two must stay separable in the funnel.
  assert(
    /emailMeTheSetupLink\('phone_card'\)/.test(onboarding)
      && /emailMeTheSetupLink\('dead_end_recovery'\)/.test(onboarding),
    'both desktop-link entry points should be tagged so uptake is attributable'
  );
});

test('on mobile, the flow leads with the step a phone can actually finish', () => {
  // Connecting means wiring an MCP server into a desktop tool. Leading a phone
  // user with it opens their account on the one task they cannot complete, so
  // capture — two text fields and a server-side project create — goes first.
  // This also fixes the empty-brief dead end: context_delivered only fires on a
  // non-suppressed injection, so an account with nothing written delivers nothing
  // on its first session no matter how well the connection went.
  assert(
    /setPhase\(mobileFirstNow \? 'capture' : 'connect'\)/.test(onboarding),
    'mobile should start on capture, desktop on connect'
  );
  // Pinned once at flow start: re-reading it live would re-order the steps under
  // a user who rotates a tablet or drags a window mid-flow.
  assert(
    /mobileFirst\.current = mobileFirstNow/.test(onboarding),
    'the ordering should be pinned when the flow starts, not read live'
  );
  // ...and pinned from a LIVE read, not from the render closure. `useIsMobile`
  // is false in the first render on every device — the server has no viewport,
  // so the hydration render must agree with it — and a []-dep effect keeps that
  // first `false` forever. Awaiting the survey lookup does not launder it: the
  // flip makes a new closure and leaves this one stale. That defect shipped and
  // pinned 100% of phone users to the desktop ordering, invisibly, because the
  // mobile CARD reads the hook live and rendered correctly the whole time.
  assert(
    /const mobileFirstNow = isMobileNow\(\)/.test(onboarding),
    'the phase decision must read the viewport live, not close over useIsMobile()'
  );
  assert(
    !/mobileFirst\.current = isMobile;/.test(onboarding),
    'phase pinning regressed to the stale first-render value of useIsMobile()'
  );
  // Capture-first must still route through connect — the brief is worthless if
  // nothing ever reads it.
  assert(
    /if \(mobileFirst\.current\) \{ setPhase\('connect'\); return; \}/.test(onboarding),
    'capture-first must hand off to the connect step, not skip it'
  );
  // And the two orderings must stay separable in the funnel. `flow` is derived
  // from the render-safe copy of the pin, not the ref: the ref exists for the
  // step callbacks, which are created once and would close over a stale value,
  // while render has to subscribe to something React actually tracks.
  assert(
    /flow = captureFirst \? 'capture_first' : 'connect_first'/.test(onboarding),
    'step events should carry which ordering produced them'
  );
  assert(
    /setCaptureFirst\(mobileFirstNow\)/.test(onboarding),
    'the render-safe copy of the ordering must be written from the same live read as the ref'
  );
});

// ── C-2: command-first for the CLI tools ────────────────────────────────────
// Of the 11 people who copied an MCP config in the 14 days to 2026-08-19, 8 never
// connected. The copy path asks them to find the right file, paste into it and
// restart the tool, with no signal when a step silently misses. For the tools that
// have a setup command, the command is the default-visible path.

test('CLI tools lead with a command, not a config to hand-edit', () => {
  assert(
    onboarding.includes('const CLI_SETUP: Record<string, CliSetup>'),
    'the CLI tools need a command-first setup table'
  );
  assert(
    onboarding.includes('command: ONE_COMMAND_SETUP'),
    'Claude Code should get the one command that does auth + registration + hooks + CLAUDE.md'
  );
  assert(
    onboarding.includes('command: CODEX_CLI_SETUP_CMDS'),
    'Codex should get its own CLI commands'
  );
  assert(
    !onboarding.includes('const isClaudeCode ='),
    'the per-tool branch should key off the CLI setup table, not one hardcoded tool — ' +
      'Codex had no command-first path because of exactly that'
  );
  assert(
    /\{cliSetup \? \(/.test(onboarding),
    'the per-tool panel should render the command path whenever the selected tool has one'
  );
  assert(
    connectCopy.includes("export const ONE_COMMAND_SETUP = 'npx -y @deerdawn/mcp-server@latest setup'"),
    'the one-command string belongs in the shared copy module, not inlined in the page'
  );
  assert(
    /\{ tool: 'Codex',/.test(connectCopy),
    'Codex needs a picker entry — without one it fell into the catch-all, which tells ' +
      'the user to paste a URL into a settings menu Codex does not have'
  );
});

test('the npx setup command is not sold to Codex, which it does not configure', () => {
  // runSetup (packages/mcp-server/src/index.ts) shells out to `claude mcp add` and
  // never writes ~/.codex/config.toml — for Codex it only refreshes an existing
  // ~/.codex/AGENTS.md. Offering it there would sign the user in and leave them
  // with no registered server.
  const codexEntry = onboarding.slice(
    onboarding.indexOf('  Codex: {'),
    onboarding.indexOf('};', onboarding.indexOf('  Codex: {'))
  );
  assert(codexEntry.length > 0, 'the Codex CLI setup entry not found');
  assert(
    !codexEntry.includes('ONE_COMMAND_SETUP'),
    'Codex must not be given the Claude Code setup command'
  );
});

test('the hand-edited config is demoted below the command, behind a disclosure', () => {
  const commandCopy = onboarding.indexOf("via: 'one_command'");
  const manualCopy = onboarding.indexOf("via: 'manual'");
  assert(commandCopy > -1, 'the primary command copy is not labelled');
  assert(manualCopy > commandCopy, 'the manual config must render after the command, not before it');
  assert(
    onboarding.slice(commandCopy, manualCopy).includes('<details'),
    'the manual config must sit behind a disclosure — it is the path the 8 died on'
  );
  assert(
    onboarding.includes('Advanced / manual setup'),
    'the disclosure should say plainly that it is the advanced path'
  );
});

// ── C-3: no-install fallback on connection timeout ──────────────────────────

test('the no-install fallback waits for the timeout and yields to any connection', () => {
  assert(
    onboarding.includes('const CONNECTION_TIMEOUT_MS = 3 * 60 * 1000;'),
    'the fallback should appear after three minutes'
  );
  const guardStart = onboarding.indexOf('const showNoInstallFallback =');
  assert(guardStart > -1, 'the fallback guard not found');
  const guard = onboarding.slice(guardStart, onboarding.indexOf(';', guardStart));
  assert(guard.includes('waitedOut'), 'nothing may be offered before the timeout — earlier is a nag');
  assert(
    guard.includes("status === 'waiting'"),
    'the fallback must disappear the moment a connection is detected'
  );
  assert(
    guard.includes('!isMobile'),
    'the mobile card already leads with this exact path; offering it there is a duplicate'
  );
  assert(
    onboarding.indexOf('{showNoInstallFallback && (') > onboarding.indexOf('Which tool are you using?'),
    'the fallback renders below the chosen path, never in place of it'
  );
});

test('taking the fallback is recorded as the setup path it is', () => {
  const start = onboarding.indexOf('const takeNoInstallPath = () => {');
  assert(start > -1, 'the fallback handler not found');
  const handler = onboarding.slice(start, onboarding.indexOf('\n  };', start));
  assert(
    handler.includes("trackProductEvent('setup_path_selected'"),
    'uptake must ride the existing setup_path_selected event — a new event name would ' +
      'make it invisible in the funnel this change is judged on'
  );
  assert(
    handler.includes("surface: 'onboarding_timeout_fallback'"),
    'and must stay separable from a picker choice'
  );
  assert(
    handler.includes('from: selectedTool'),
    'record which local path the user was rescued out of'
  );
  assert(
    handler.includes('pathChosen.current = true'),
    'the fallback IS a path choice, so a later picker click is a change of path, not a first pick'
  );
  assert(
    handler.includes('setSelectedTool(NO_INSTALL_TOOL)'),
    'the fallback must switch the user onto the hosted path, not merely describe it'
  );
  assert(
    onboarding.includes("trackProductEvent('onboarding_no_install_offered'"),
    'uptake needs a denominator — record that the offer was shown'
  );
});

test('the three funnel events this change is judged on are all still emitted', () => {
  // Pins the events, not the change: this passes before and after C-2/C-3 and
  // exists so a later edit cannot quietly drop one. The `via` discriminators below
  // are the part that is new.
  for (const event of ['setup_path_selected', 'mcp_config_copied', 'mcp_setup_viewed']) {
    assert(onboarding.includes(`'${event}'`), `${event} is no longer emitted from the connect step`);
  }
  assert(
    onboarding.includes("via: 'one_command'") && onboarding.includes("via: 'manual'"),
    'mcp_config_copied alone cannot say which of the two paths was taken — it needs the discriminator'
  );
});

test('every mcp_config_copied emitter says which artifact was copied', () => {
  // Measured 2026-09-01, 30 days, is_test excluded: 16 people copied a connector
  // config. The two surfaces carrying 15 of them — the mobile card's connector
  // URL and the remote-setup URL paste — emitted NO `via` at all, while the CLI
  // branches beside them tagged 'one_command' / 'manual'. So "copied a command"
  // and "copied a URL" were separable for the tools the gap does not live in,
  // and indistinguishable for Claude.ai, which is 16 of the 17 copies.
  //
  // Asserted over every emitter rather than by naming the two that were wrong:
  // a ninth copy button added later must not be able to land untagged.
  const emitters = onboarding.match(/trackProductEvent\('mcp_config_copied',[^\n]*\)/g) || [];
  assert(emitters.length >= 8, `expected the full set of copy emitters, found ${emitters.length}`);
  const untagged = emitters.filter((e) => !/\bvia: '/.test(e) || !/\bsurface: '/.test(e));
  assert.deepStrictEqual(
    untagged,
    [],
    'every mcp_config_copied must carry both `surface` (which card) and `via` (which artifact) — '
      + 'without `via` the event cannot say whether a URL, a command, a config file or a prompt was taken'
  );
});

test('copying a prompt is not reported as copying a connector config', () => {
  // mcp_config_copied is mapped to the Google Ads "connect attempted" conversion
  // in productAnalytics. The first-brief and automation prompts are not configs;
  // until 2026-09-16 they emitted it anyway, so Ads bid on prompt copies.
  const configCopies = onboarding.match(/trackProductEvent\('mcp_config_copied',[^\n]*\)/g) || [];
  const promptCopies = configCopies.filter((e) => /via: '(brief_prompt|automation_prompt)'/.test(e));
  assert.deepStrictEqual(promptCopies, [], 'prompt copies must use onboarding_prompt_copied');
  assert(/trackProductEvent\('onboarding_prompt_copied'/.test(onboarding), 'the prompt copies should still be tracked');
});

test('a copy records whether its tool was chosen or merely the default', () => {
  // THE DEFECT THIS EXISTS FOR. The picker fires `setup_path_selected` only when
  // the clicked tool DIFFERS from the current one, and selectedTool initialises
  // to REMOTE_SETUP_LOCATIONS[0] = 'Claude.ai'. A Claude.ai user therefore cannot
  // fire it from the picker at all — their tool is already selected, so there is
  // nothing to change. Measured 2026-09-01 over the 43 people who reached a setup
  // surface in 30 days: 8 selected a path and copied, 9 selected without copying,
  // and 8 copied WITHOUT EVER SELECTING. Read as a funnel step, that last group
  // looks like drop-out; it is the default path being taken silently.
  assert(
    /const toolSource = \(\) => \(pathChosen\.current \? 'picked' : 'default'\)/.test(onboarding),
    'tool_source must be derived from the pathChosen latch, not from selectedTool being non-empty — '
      + 'selectedTool is never empty, so any check on it would report `picked` for everyone'
  );
  assert(
    /REMOTE_SETUP_LOCATIONS\[0\]\.tool/.test(onboarding),
    'the picker still initialises from the first location; if that changed, the default this measures moved'
  );
  const withTool = onboarding.match(/trackProductEvent\('mcp_config_copied',[^\n]*tool: selectedTool[^\n]*\)/g) || [];
  assert(withTool.length >= 4, `expected the selectedTool-bearing copy emitters, found ${withTool.length}`);
  const missing = withTool.filter((e) => !/tool_source: toolSource\(\)/.test(e));
  assert.deepStrictEqual(
    missing,
    [],
    'a copy taken against selectedTool must record tool_source, or `default` and `picked` stay averaged together'
  );
});

test('setup_path_selected is not claimed to be the funnel step it cannot be', () => {
  // Guards the comment, because the comment is the finding. The picker's
  // `loc.tool !== selectedTool` guard is correct behaviour — re-emitting on a
  // no-op click would be worse — but it means the event measures "changed away
  // from the default", not "chose a path". Anything reading it as the latter is
  // wrong by roughly a factor of two.
  assert(
    /loc\.tool !== selectedTool/.test(onboarding),
    'the picker no longer guards on a changed tool — re-check what setup_path_selected now means'
  );
  assert(
    /cannot fire that event\n\s*\/\/ from this picker at all/.test(onboarding),
    'the reason tool_source exists must stay written next to it'
  );
});
