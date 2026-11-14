const express = require('express');
const router = express.Router();
const db = require('../../config/db');
const { requireAuth } = require('../../middleware/auth');
const { getOnboardingState } = require('../../services/onboardingService');
const { getEntitlements } = require('../../services/entitlementService');
const { deploymentInfo } = require('../../config/selfHosted');
const { normalizePlanId, getPlan, isSelfServePlan } = require('../../config/plans');
const { getUsageSummary } = require('./billing');
const workspace = require('../../services/workspaceService');
const connectionIdentity = require('../../services/connectionIdentity');
const toolUsageDays = require('../../services/toolUsageDays');

router.use(requireAuth);

const DONE_PROGRESS = new Set(['completed', 'done', 'closed', 'shipped']);

// THE ACTIVE-TASK CARD, CHOSEN FROM WHAT THIS PERSON MAY READ, AFTER DECRYPTION.
//
// This was one SQL query over `context->>'current_task'` filtered only on
// owner_key, and it was wrong both ways at once:
//   - on a plaintext row it picked from EVERY project in the workspace, so a
//     teammate's dashboard printed a colleague's PERSONAL project name and its
//     current task — the state that means "its author, and nobody else";
//   - on an encrypted row (production: context is stored as { _enc }) the JSON
//     path is NULL, so the card was silently empty for everybody, the author
//     included.
// So the candidates come from the store's visibility-filtered listing (which
// decrypts), are narrowed to the section-filtered view a teammate reads, and the
// task is picked in JS. A share that withholds current_task yields no candidate.
// Same shape as the query it replaces: { rows: [row] }.
async function pickActiveTask(actor, ownerKey) {
  const store = require('../../store/contextSyncStore');
  const contextSync = require('../../services/contextSyncService');
  const isSystem = actor?.type === 'system' || ownerKey === 'org-system';
  const listed = await store.listProjects(ownerKey, {
    system: isSystem,
    actorIdentities: workspace.actorIdentities(actor),
    isWorkspaceOwner: !isSystem
      && (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner',
  });
  const projects = await contextSync.viewProjectsForActor(actor, listed);
  const candidates = projects
    .map((project) => ({ project, context: project.context || {} }))
    .filter(({ context }) => typeof context.current_task === 'string' && context.current_task.trim())
    .sort((a, b) => {
      const doneA = DONE_PROGRESS.has(String(a.context.task_progress || '').toLowerCase()) ? 1 : 0;
      const doneB = DONE_PROGRESS.has(String(b.context.task_progress || '').toLowerCase()) ? 1 : 0;
      if (doneA !== doneB) return doneA - doneB;
      return (Date.parse(b.project.updated_at || '') || 0) - (Date.parse(a.project.updated_at || '') || 0);
    });
  const top = candidates[0];
  if (!top) return { rows: [] };
  return {
    rows: [{
      project_id: top.project.project_id,
      project_name: top.project.project_name,
      updated_at: top.project.updated_at,
      current_task: top.context.current_task,
      task_progress: String(top.context.task_progress || ''),
      command_count: Array.isArray(top.context.commands) ? top.context.commands.length : 0,
    }],
  };
}

router.get('/bootstrap', async (req, res) => {
  // The bound workspace. Reading req.actor.org_id showed a Free invitee working
  // in a Team workspace a FREE badge and upgrade nags for the plan they are on.
  const orgId = (req.actor.workspace_key || req.actor.org_id) ? workspace.defaultOwnerKey(req.actor) : null;
  if (!orgId) {
    return res.status(403).json({
      status: 'error',
      error_code: 'forbidden',
      error: 'forbidden',
      message: 'No organization context is available for this session.',
    });
  }

  try {
    const ownerKey = orgId;
    // ONBOARDING IS ABOUT A PERSON, NOT ABOUT THEIR WORKSPACE.
    //
    // "Has a brief", "has connected a tool" and "has had a first sync" were all
    // asked of the workspace. On a solo account those are the same question. On a
    // team they are not: a teammate invited today inherited the founder's
    // projects, the founder's MCP traffic and the founder's first sync, so they
    // landed already "briefed" and "connected", skipped every setup step, and
    // were never shown how to connect the tool they had never connected.
    //
    // Scoped only when there is somebody else to be confused with, so a solo
    // account (and every row written before events carried a user_id) reads
    // exactly as it did.
    const personIds = workspace.actorIdentities(req.actor).filter(Boolean);
    //
    // "MORE THAN ONE PERSON" MEANS EVER HELD, not currently active, and it is the
    // one rule the unowned-row credit follows everywhere (the SQL in
    // sessionCatchupService, recordSessionLoad and referralService counts every
    // roster row, removed included). It is monotone: a workspace that once held
    // two never goes back to crediting a row with no person to whoever is left,
    // so the dashboard and the activation emitters cannot disagree, and no
    // emitter fires twice as membership shrinks and grows.
    const scopeToPerson = personIds.length > 0
      && await workspace.hasEverHeldTwoMembers(ownerKey).catch(() => false);
    const personParams = scopeToPerson ? [personIds] : [];
    // Rows with NO person on them (older rows, or ones an internal job wrote)
    // count for nobody once there is more than one person. They used to be
    // handed to every workspace owner, so a co-owner who had connected nothing
    // read as connected and synced. Only a person's own rows are theirs; the
    // same rule an unmatched git author follows.
    const personMatch = (column) => ` AND ${column} = ANY($2)`;
    const eventPersonClause = scopeToPerson ? personMatch('user_id') : '';
    const projectPersonClause = scopeToPerson ? personMatch('owner_user_id') : '';
    const [orgRes, countersRes, policyRes, recentRes, statsRes, onboardingState, contextProjectsRes, usageSummary, activeTaskRes, mcpRuntimeRes, firstSyncRes, mcpSurfaceRes, sessionLoadsRes, connectorGrantRes, mcpToolRes, activeDays] = await Promise.all([
      db.query(
        `SELECT org_id, name, account_type, plan, plan_tier, subscription_status, trial_ends_at,
                billing_period_start, billing_period_end, stripe_customer_id, shadow_mode, onboarding_template, referral_premium_until,
                team_trial_started_at
         FROM organizations
         WHERE org_id = $1`,
        [orgId],
        orgId
      ),
      db.query(
        `SELECT
            (SELECT COUNT(*) FROM api_keys WHERE org_id = $1) AS api_keys,
            (SELECT COUNT(*) FROM integrations WHERE org_id = $1) AS integrations,
            (SELECT COUNT(*) FROM users WHERE org_id = $1 AND role = 'admin') AS admins,
            (SELECT COUNT(*) FROM audit_logs WHERE org_id = $1) AS audit_events,
            (SELECT COUNT(*) FROM escalation_resolutions WHERE org_id = $1 AND status = 'pending') AS pending_escalations`,
        [orgId],
        orgId
      ),
      db.query('SELECT COUNT(*) FROM policies WHERE org_id = $1 AND enabled = true', [orgId], orgId),
      db.query(
        `SELECT decision_id, created_at, action_type, decision, policy_ids, latency, trace_id, environment, summary, reason
         FROM decisions
         WHERE org_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [orgId],
        orgId
      ),
      db.query(
        `SELECT COUNT(*) AS total,
                AVG(latency_ms) AS avg_latency,
                COUNT(*) FILTER (WHERE decision = 'escalate') AS escalations
         FROM decisions
         WHERE org_id = $1`,
        [orgId],
        orgId
      ),
      getOnboardingState(orgId, req.actor.id),
      db.query(
        `SELECT COUNT(*) AS total,
                MAX(updated_at) AS last_synced,
                COUNT(*) FILTER (WHERE updated_at > NOW() - INTERVAL '5 minutes') AS recent_syncs
         FROM context_projects WHERE owner_key = $1${projectPersonClause}`,
        [ownerKey, ...personParams],
        'org-system'
      ).catch(() => ({ rows: [{ total: 0, last_synced: null, recent_syncs: 0 }] })),
      getUsageSummary(orgId).catch(() => ({ syncs_used: 0, syncs_limit: null, pct: 0 })),
      pickActiveTask(req.actor, ownerKey).catch((err) => {
        console.warn('[DASHBOARD] active task unavailable:', err.message);
        return { rows: [] };
      }),
      // Has an authed MCP runtime checked in recently? The MCP server emits
      // source='mcp' events (mcp_runtime_started, mcp_*_succeeded) only after auth
      // resolves, so this confirms a working connection even before any project exists.
      db.query(
        `SELECT COUNT(*) AS mcp_events
           FROM product_events
          WHERE org_id = $1 AND source = 'mcp'${eventPersonClause}
            AND created_at > NOW() - INTERVAL '30 days'`,
        [orgId, ...personParams],
        orgId
      ).catch(() => ({ rows: [{ mcp_events: 0 }] })),
      // Has this user ever completed a first sync? Recorded once per user by
      // maybeEmitFirstSyncActivation the first time context is delivered into any
      // tool. This is the DURABLE activation signal: unlike the onboarding page's
      // in-page poll, it survives the user closing the tab, so someone who
      // connects from their editor and comes back tomorrow is still activated.
      db.query(
        `SELECT MIN(created_at) AS first_sync_at
           FROM product_events
          WHERE org_id = $1 AND event_name = 'first_sync_completed'${eventPersonClause}`,
        [orgId, ...personParams],
        orgId
      ).catch(() => ({ rows: [] })),
      // Per-surface MCP call rate: which tools (Claude Code, Cursor, Codex,
      // Claude.ai, ChatGPT) are actually calling DeerDawn, how often, and whether
      // they load context (start_session) vs skip it. Drives the "DeerDawn is
      // being used by …" panel and the not-used nudge. Event names mirror both
      // the local CLI server and the remote web server.
      //
      // `handshakes` is which clients INTRODUCED themselves on each surface.
      // Hosted calls recorded before a call could be labelled from its
      // credential (and calls still arriving on a credential minted before keys
      // carried their client's name) sit under 'unknown_web'. Those rows are
      // not rewritten; Setup credits them to a web tool only when exactly one
      // web tool handshook and no unidentified client did (setup.tsx
      // usageByToolId), and it needs this count to know.
      db.query(
        `SELECT COALESCE(surface, 'unknown') AS surface,
                COUNT(*) FILTER (WHERE event_name = 'mcp_start_session_succeeded') AS start_sessions,
                COUNT(*) FILTER (WHERE event_name = 'mcp_start_session_skipped') AS start_session_skips,
                COUNT(*) FILTER (WHERE metadata->>'tool_name' = 'update_context') AS update_contexts,
                COUNT(*) FILTER (WHERE event_name IN ('mcp_tool_call_succeeded', 'mcp_start_session_succeeded')) AS tool_calls,
                COUNT(*) FILTER (WHERE event_name = 'mcp_runtime_started') AS handshakes,
                MAX(created_at) AS last_called_at
           FROM product_events
          WHERE org_id = $1 AND source = 'mcp'
            AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY COALESCE(surface, 'unknown')`,
        [orgId],
        orgId
      ).catch(() => ({ rows: [] })),
      // Ambient accumulation: lifetime session count + first session — powers the
      // "Session N · context since <month>" badge. A fact, not a streak. The
      // table is created lazily by the context store, so tolerate its absence.
      db.query(
        `SELECT COUNT(*)::int AS total_sessions, MIN(created_at) AS first_session_at
           FROM context_session_loads
          WHERE owner_key = $1`,
        [ownerKey],
        'org-system'
      ).catch(() => ({ rows: [{ total_sessions: 0, first_session_at: null }] })),
      // Has this person authorized a hosted connector (ChatGPT, claude.ai) that
      // has not called us yet? The token endpoint mints an api_keys row with
      // oauth_resource set when the client exchanges its code, which is the
      // client's server holding a live credential. ChatGPT exchanges the code
      // at approve and does not call `initialize` until a chat uses the
      // connector, so for that whole gap mcp_registered reads false and the
      // empty workspace told someone who had just connected to "Connect a tool"
      // (2026-09-27, two test signups through ChatGPT).
      //
      // NOT connection evidence and deliberately kept out of mcp_registered: a
      // handshake is not a tool call (activation-connector-not-a-trigger). It
      // only lets the empty state stop asking for a step the person has done.
      db.query(
        `SELECT oauth_client_name
           FROM api_keys
          WHERE org_id = $1 AND oauth_resource IS NOT NULL AND status = 'active'
            AND (expires_at IS NULL OR expires_at > NOW())${scopeToPerson ? ' AND owner_id = ANY($2)' : ''}
          ORDER BY created_at DESC
          LIMIT 1`,
        [orgId, ...personParams],
        'org-system'
      ).catch(() => ({ rows: [] })),
      // The same events as mcp_surfaces, by WHICH TOOL and HOW IT CONNECTED
      // instead of by the one mixed `surface` field (connectionIdentity). A
      // hosted Claude Code, Codex or Cursor is filed under 'unknown_web' by
      // surface and has a tool here; a row with no tool is a client nothing
      // could name. Rows written before the two columns are derived.
      db.query(
        `SELECT ${connectionIdentity.toolSql()} AS tool,
                ${connectionIdentity.transportSql()} AS transport,
                COUNT(*) FILTER (WHERE event_name = 'mcp_start_session_succeeded') AS start_sessions,
                COUNT(*) FILTER (WHERE event_name = 'mcp_start_session_skipped') AS start_session_skips,
                COUNT(*) FILTER (WHERE metadata->>'tool_name' = 'update_context') AS update_contexts,
                COUNT(*) FILTER (WHERE event_name IN ('mcp_tool_call_succeeded', 'mcp_start_session_succeeded')) AS tool_calls,
                COUNT(*) FILTER (WHERE event_name = 'mcp_runtime_started') AS handshakes,
                MAX(created_at) AS last_called_at
           FROM product_events
          WHERE org_id = $1 AND source = 'mcp'
            AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY 1, 2`,
        [orgId],
        orgId
      ).catch(() => ({ rows: [] })),
      // On how many distinct UTC days has THIS PERSON used DeerDawn from an AI
      // tool? Always per person, never per workspace: it gates the upgrade asks
      // (Thing 3h — no ask before someone has been active on 3 days), and a
      // teammate must not inherit the owner's days. 0 on any error.
      toolUsageDays.countActiveDays(workspace.actorPersonId(req.actor)),
    ]);

    const org = orgRes.rows[0];
    if (!org) {
      return res.status(404).json({
        status: 'error',
        error_code: 'org_not_found',
        error: 'org_not_found',
        message: 'Workspace not found for the current session.',
      });
    }
    const counters = countersRes.rows[0] || {};
    const stats = statsRes.rows[0] || {};
    const total = Number.parseInt(stats.total || 0, 10);
    const escalations = Number.parseInt(stats.escalations || 0, 10);
    const escalationRate = total > 0 ? `${((escalations / total) * 100).toFixed(2)}%` : '0.00%';
    const planTier = normalizePlanId(org.plan_tier || org.plan);
    const planConfig = getPlan(planTier);
    const integrationCount = Number.parseInt(counters.integrations || 0, 10);
    const apiKeyCount = Number.parseInt(counters.api_keys || 0, 10);
    const pendingEscalations = Number.parseInt(counters.pending_escalations || 0, 10);
    const auditEvents = Number.parseInt(counters.audit_events || 0, 10);
    // Referral rewards used to be triggered here on any dashboard load with a
    // project, integration or API key. They are paid on first_sync_completed now
    // (sessionCatchupService.maybeEmitFirstSyncActivation), the real activation.

    const entitlements = await getEntitlements(orgId);
    // Free is uncapped on volume (included_decisions is null), so there is no trial
    // allowance to count down — surface null ("unlimited") rather than a frozen 0.
    const freeDecisionLimit = entitlements.limits?.included_decisions;
    const remainingTrialActions = planTier === 'free' && Number.isFinite(freeDecisionLimit)
      ? Math.max(freeDecisionLimit - total, 0)
      : null;

    const visibleNavigation = {
      show_escalations: Boolean(entitlements.features?.human_approval) && (pendingEscalations > 0 || onboardingState.progress?.decision),
      show_audit: Boolean(entitlements.features?.audit_log) && (auditEvents > 0 || onboardingState.completed_steps >= 2),
      show_usage: total > 0,
      show_playground: false,
    };

    let commandCapture = {
      active_task_project_id: null,
      active_task_project_name: null,
      active_task_label: null,
      open_task_command_count: 0,
      last_captured_command_at: null,
    };

    const activeTask = activeTaskRes.rows[0] || null;
    if (activeTask) {
      let lastCommandAt = null;
      try {
        const commandEventRes = await db.query(
          `SELECT MAX(created_at) AS last_captured_command_at
           FROM context_events
           WHERE project_id = $1 AND event_kind = 'command_confirmed'`,
          [activeTask.project_id],
          'org-system'
        );
        lastCommandAt = commandEventRes.rows[0]?.last_captured_command_at || null;
      } catch {
        lastCommandAt = null;
      }

      commandCapture = {
        active_task_project_id: activeTask.project_id,
        active_task_project_name: activeTask.project_name,
        active_task_label: activeTask.current_task || null,
        open_task_command_count: Number(activeTask.command_count || 0),
        last_captured_command_at: lastCommandAt,
      };
    }

    res.json({
      status: 'ok',
      error_code: null,
      // Self-hosted / billing / telemetry / signup mode, the same object
      // GET /api/v1/public/deployment answers. The dashboard hides billing and
      // plan UI when self_hosted is true.
      deployment: deploymentInfo(),
      user: {
        id: req.actor.id,
        email: req.actor.email,
        role: req.actor.role,
      },
      org: {
        id: org.org_id,
        name: org.name,
        account_type: org.account_type,
        plan_tier: planTier,
        plan_label: planConfig.publicName,
        subscription_status: org.subscription_status,
        trial_ends_at: org.trial_ends_at,
        // With the end, the LENGTH of the period: the dashboard reads the
        // billing cycle off it (planCopy.billingCycleOnRecord), so a card
        // marked "Current plan" can show what this workspace is charged.
        billing_period_start: org.billing_period_start,
        billing_period_end: org.billing_period_end,
        stripe_customer_id: org.stripe_customer_id,
        // One Team trial per workspace: null = this workspace has never had one.
        team_trial_started_at: org.team_trial_started_at || null,
        shadow_mode: org.shadow_mode || false,
        onboarding_template: onboardingState.template,
        referral_premium_until: entitlements.referral_premium_until || null,
        referral_premium_active: Boolean(entitlements.referral_premium_active),
      },
      onboarding: onboardingState,
      usage: {
        integrations: integrationCount,
        admins: Number.parseInt(counters.admins || 0, 10),
        api_keys: apiKeyCount,
        limits: entitlements.limits,
        syncs: usageSummary,
      },
      entitlements,
      shell: {
        status: org.shadow_mode ? 'shadow' : 'operational',
        pending_escalations: pendingEscalations,
        audit_events: auditEvents,
        visible_navigation: visibleNavigation,
        counts: {
          integrations: integrationCount,
          api_keys: apiKeyCount,
          decisions: total,
          policies: Number.parseInt(policyRes.rows[0]?.count || 0, 10),
        },
        nav: visibleNavigation,
      },
      billing: {
        plan_tier: planTier,
        overage_per_decision: planConfig.overage_per_decision ?? null,
        remaining_trial_actions: remainingTrialActions,
        referral_premium_until: entitlements.referral_premium_until || null,
        referral_premium_active: Boolean(entitlements.referral_premium_active),
        subscription_status: org.subscription_status,
        trial_ends_at: org.trial_ends_at,
        billing_period_end: org.billing_period_end,
        self_serve: isSelfServePlan(planTier),
        usage_summary: usageSummary,
      },
      metrics: {
        total_decisions: total,
        escalation_rate: escalationRate,
        avg_latency: stats.avg_latency ? `${Math.round(Number(stats.avg_latency))}ms` : '—',
        policies_enabled: Number.parseInt(policyRes.rows[0]?.count || 0, 10),
      },
      sync_health: (() => {
        const cp = contextProjectsRes.rows[0] || {};
        const hasProjects = Number(cp.total || 0) > 0;
        const lastSynced = cp.last_synced || null;
        const recentlySynced = Number(cp.recent_syncs || 0) > 0;
        const mcpConnected = Number(mcpRuntimeRes.rows[0]?.mcp_events || 0) > 0;
        // The activation signal the onboarding gate reads. Durable and
        // server-side, so it cannot be missed by a page that was closed.
        const firstSyncAt = firstSyncRes.rows?.[0]?.first_sync_at || null;
        // Per-surface call rate (30d). For CLI surfaces the local server tracks
        // start_session skips, so we can compute a real "loaded context %"; web
        // surfaces (stateless HTTP) have no skip signal, so call_rate is null and
        // the UI falls back to last-seen/recency.
        const surfaces = (mcpSurfaceRes.rows || []).map((row) => {
          const starts = Number(row.start_sessions || 0);
          const skips = Number(row.start_session_skips || 0);
          const denom = starts + skips;
          return {
            surface: row.surface,
            start_sessions: starts,
            start_session_skips: skips,
            update_contexts: Number(row.update_contexts || 0),
            tool_calls: Number(row.tool_calls || 0),
            handshakes: Number(row.handshakes || 0),
            last_called_at: row.last_called_at || null,
            // % of session-starts that actually called start_session (CLI only).
            call_rate: denom > 0 ? Math.round((starts / denom) * 100) : null,
          };
        });
        const loads = sessionLoadsRes.rows[0] || {};
        return {
          has_projects: hasProjects,
          last_synced: lastSynced,
          recently_active: recentlySynced,
          // Activation, as the funnel defines it: the user's first context
          // delivery into any tool. Onboarding gates completion on this rather
          // than on a client-side poll, so a sync that lands while the tab is
          // closed still counts.
          first_synced_at: firstSyncAt,
          has_first_sync: Boolean(firstSyncAt),
          // Distinct UTC days this person called DeerDawn from an AI tool (reads
          // included, from tool_usage_days; earlier days from the MCP call
          // events). The dashboard holds every upgrade ask until this is 3.
          active_days: Number(activeDays || 0),
          desktop_connected: recentlySynced,
          // Evidence of an actual connection, and nothing else.
          //
          // `mcpConnected` is product_events rows with source='mcp': the hosted
          // dispatcher writes mcp_runtime_started on `initialize` and
          // mcp_tool_call_succeeded / mcp_start_session_succeeded per call, and
          // the local stdio server writes the same names only after auth
          // resolves. Either way a real client reached us holding a real
          // credential — which is what makes "Test connection" pass for a fresh
          // user who has not created a project yet, the case this flag exists
          // for. The device-flow events are source='mcp_auth' and deliberately
          // outside this set: an abandoned sign-in is not a connection.
          //
          // `recentlySynced` and `hasProjects` used to be ORed in here and both
          // were wrong: they are satisfied by a context_projects row, and the
          // DASHBOARD creates those itself. The onboarding capture step's "Save
          // my first brief" button is one POST, and on the capture-first (phone)
          // ordering it runs BEFORE the connect step — so a user who had never
          // opened an AI tool arrived at the connect step already registered,
          // auto-advanced, and was recorded with verified_connection: true. The
          // metric the company steers by was being minted by our own write path.
          // A project is not a connection; has_projects is still published above
          // for the callers that genuinely want to know whether context exists.
          mcp_registered: mcpConnected,
          // A connector holds a live OAuth credential for this person. Display
          // only — see the connectorGrantRes query. Never fold into the above.
          connector_authorized: connectorGrantRes.rows.length > 0,
          connector_client_name: connectorGrantRes.rows[0]?.oauth_client_name || null,
          mcp_surfaces: surfaces,
          // Additive: the same calls by tool and transport. `tool` is null for a
          // client nothing could name.
          mcp_tools: (mcpToolRes.rows || []).map((row) => ({
            tool: connectionIdentity.displayTool(row.tool, row.transport),
            transport: row.transport || null,
            start_sessions: Number(row.start_sessions || 0),
            start_session_skips: Number(row.start_session_skips || 0),
            update_contexts: Number(row.update_contexts || 0),
            tool_calls: Number(row.tool_calls || 0),
            handshakes: Number(row.handshakes || 0),
            last_called_at: row.last_called_at || null,
          })),
          command_capture: commandCapture,
          // Lifetime accumulation (all projects): "Session N · context since <month>".
          session_stats: {
            total_sessions: Number(loads.total_sessions || 0),
            first_session_at: loads.first_session_at || null,
          },
        };
      })(),
      cta: {
        next_step: onboardingState.recommended_next_step || '/api-keys',
        recommended_label:
          !onboardingState.progress?.api_key
            ? 'Create your first API key'
            : !onboardingState.progress?.decision
              ? 'Download the desktop app'
              : ['trial_active', 'active'].includes(org.subscription_status)
                ? 'View your context graph'
                : 'Upgrade your plan',
      },
      recent_decisions: recentRes.rows.map((row) => ({
        id: row.decision_id,
        ts: row.created_at,
        action: row.action_type,
        decision: row.decision,
        policy: Array.isArray(row.policy_ids) && row.policy_ids.length > 0 ? row.policy_ids[0] : '-',
        latency: row.latency,
        trace_id: row.trace_id,
        environment: row.environment,
        summary: row.summary,
        shadow: typeof row.reason === 'string' && row.reason.startsWith('shadow:'),
      })),
    });
  } catch (err) {
    console.error('[DASHBOARD] Failed to build bootstrap payload:', err.message);
    res.status(500).json({
      status: 'error',
      error_code: 'bootstrap_failed',
      error: 'internal_error',
      message: 'Failed to build workspace bootstrap payload.',
    });
  }
});

module.exports = router;
