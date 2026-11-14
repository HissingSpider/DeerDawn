/**
 * Canonical product-event names — one name per funnel step, shared across both
 * analytics sinks (PostHog via trackProductEvent + GA4 via gaEvent) so the funnel
 * is joinable across tools. New product events go here and are referenced by
 * constant, never hand-typed.
 *
 * Only names that ACTUALLY FIRE are listed (verified in PostHog 474086). The full
 * canonical funnel — including documented gaps not yet emitted — lives in
 * docs/growth/funnel-tracking.md. Marketing top-of-funnel names live in the
 * marketing app's own lib/analyticsEvents.ts (MARKETING_EVENTS).
 *
 * The revenue funnel previously split a single "checkout started" click across
 * three PostHog names; every checkout entry point now fires the single
 * `checkoutStarted` name to BOTH sinks, with the entry surface in metadata.
 */
export const PRODUCT_EVENTS = {
  // ── Auth / account ─────────────────────────────────────────────────────────
  signupStarted: 'signup_started',
  /**
   * Email/password signup form completed. NOT the signup count — this path is
   * client-side only, so it structurally misses every Google-OAuth signup
   * (11 of 22 real signups over 2026-06-21..08-04 had no such event). Use
   * `accountCreated` for any signup numerator or funnel terminal step.
   */
  signupCompleted: 'signup_completed',
  // Authoritative signup signal — server-side, Clerk user.created webhook. Fires
  // exactly once per real account (email + OAuth). NOT emitted client-side.
  accountCreated: 'account_created',
  /**
   * "Continue with Google" was clicked while a session already existed, so the
   * page asked which account was meant instead of guessing. Same names as the
   * marketing form's MARKETING_EVENTS so the two surfaces join.
   *
   * Expect this to be RARE here and not to mean the prompt is unused: the mount
   * redirect in ClerkAuthPage moves signed-in users on before they can click, so
   * the only window this app can fire it in is the hydration gap that produced
   * the 2026-08-28 report. Marketing is where the question is normally asked.
   */
  oauthSignedInPrompted: 'oauth_signed_in_prompted',
  /** How it was answered. `choice`: 'continue' | 'switch'. */
  oauthSignedInResolved: 'oauth_signed_in_resolved',

  // ── Onboarding / setup ─────────────────────────────────────────────────────
  onboardingPageViewed: 'onboarding_page_viewed',
  onboardingCaptureViewed: 'onboarding_capture_viewed',
  onboardingStepCompleted: 'onboarding_step_completed',
  onboardingContinueClicked: 'onboarding_continue_clicked',
  onboardingAdvancedOpened: 'onboarding_advanced_opened',
  onboardingCompleted: 'onboarding_completed',
  // Left the flow before setup was verified. The counterpart to onboardingCompleted:
  // since both connect and capture are now gated on server-verified signals, a user
  // who bails emits THIS instead of a false completion. onboarding_completed minus
  // onboarding_exited_early is the honest setup funnel.
  onboardingExitedEarly: 'onboarding_exited_early',
  onboardingSurveyViewed: 'onboarding_survey_viewed',
  onboardingSurveySubmitted: 'onboarding_survey_submitted',
  onboardingSurveySkipped: 'onboarding_survey_skipped',
  // setup_path_selected is the FIRST tool pick — the funnel's setup-path step.
  // setup_path_changed is every pick after it: the user hunting for instructions
  // that look right. Kept apart because counting both as "selected" made 12
  // people look like 31 setup starts.
  setupPathSelected: 'setup_path_selected',
  setupPathChanged: 'setup_path_changed',
  mcpSetupViewed: 'mcp_setup_viewed',
  mcpConfigCopied: 'mcp_config_copied',
  // A copied PROMPT (write my first brief / make it automatic). Kept out of
  // mcp_config_copied, which is a Google Ads connect conversion.
  onboardingPromptCopied: 'onboarding_prompt_copied',
  mcpConnectionTested: 'mcp_connection_tested',
  onboardingConnectionDetected: 'onboarding_connection_detected',
  onboardingNoInstallOffered: 'onboarding_no_install_offered',
  mobileSetupLinkRequested: 'mobile_setup_link_requested',

  // A connected tool is not a tool that has been asked for anything. Over the
  // 90 days to 2026-08-26, 3 of the 8 accounts that completed an MCP handshake
  // never produced a single tool call, while their connectors kept
  // re-handshaking — so connection_established (which needs a start_session that
  // reaches the server) was unreachable for them by construction. These two
  // measure the surface that hands the user the standing instruction that closes
  // that gap. `_shown` is an IntersectionObserver impression at threshold 0.5,
  // never a mount, so it counts people rather than renders.
  connectAutomationShown: 'connect_automation_shown',
  connectAutomationCopied: 'connect_automation_copied',

  // ── Authorize (the hop between "copied the URL" and "connected") ───────────
  // Emitted by BOTH authorization surfaces, separated by metadata.surface:
  //   'oauth_consent'   /oauth/consent  — authorization-code flow (Claude.ai,
  //                                       ChatGPT, Cursor remote connectors)
  //   'mcp_device_code' /mcp-auth       — device-code flow (`claude mcp add`)
  // Added 2026-08-05. Until then this step emitted NOTHING, which is why a
  // 14-day window with 33 accounts, 6 connect-URL copies and 0 activations
  // could not say whether anyone ever reached the authorize screen at all.
  // oauth_consent_viewed carries has_request (0 = the tool sent the user here
  // with no authorization request — a broken hand-off, not a change of mind).
  oauthConsentViewed: 'oauth_consent_viewed',
  oauthConsentApproved: 'oauth_consent_approved',
  oauthConsentSigninRequired: 'oauth_consent_signin_required',
  oauthConsentFailed: 'oauth_consent_failed',
  /**
   * A signed-out arrival at an authorize screen, emitted when the sign-in panel
   * renders — the denominator `oauth_consent_signin_required` could never be.
   * That event only fires on a Connect click, and over the 90 days to
   * 2026-08-28 it has fired zero times, because the 5 signed-out arrivals in
   * that window never pressed the button they were shown. Pair
   * `oauthConsentSigninClicked` with this to separate "did not try" from
   * "tried and the round trip lost them".
   */
  oauthConsentSigninShown: 'oauth_consent_signin_shown',
  oauthConsentSigninClicked: 'oauth_consent_signin_clicked',
  /**
   * "Not you? Switch account" on an authorize screen. A signed-in arrival who
   * presses this was about to connect the wrong account: until 2026-09 the badge
   * showed a first name only, so there was no way to notice and no way to act.
   */
  oauthConsentSwitchAccountClicked: 'oauth_consent_switch_account_clicked',

  // ── Activation (first useful value) ────────────────────────────────────────
  // Activation = reaching first_sync_completed after account_created. See the
  // activation definition in docs/growth/funnel-tracking.md.
  onboardingFirstBriefDetected: 'onboarding_first_brief_detected',
  firstSyncCompleted: 'first_sync_completed',
  firstSyncCelebrated: 'first_sync_celebrated',
  projectCreated: 'project_created',

  // ── Lifecycle email ────────────────────────────────────────────────────────
  /**
   * A lifecycle email's CTA was clicked — recorded when the dashboard loads with
   * ?dd_email=<email type>, not by the ESP. Resend only reports opens/clicks
   * when tracking is enabled per sending domain in its dashboard, which apps/api
   * cannot set, so without this the activation follow-up has no click signal at
   * all: 52 sent / 14 delivered / 0 activations in the 30d to 2026-08-15 with no
   * way to separate "unread" from "read, then the landing page lost them".
   * Compare against activation_followup_email_sent, never against a raw pageview.
   */
  lifecycleEmailClicked: 'lifecycle_email_clicked',

  // ── Context import ─────────────────────────────────────────────────────────
  contextImportViewed: 'context_import_viewed',
  contextImportStarted: 'context_import_started',
  contextImportSucceeded: 'context_import_succeeded',
  contextImportFailed: 'context_import_failed',
  contextBriefPreviewed: 'context_brief_previewed',

  // ── Revenue / upgrade funnel ───────────────────────────────────────────────
  selectPlanViewed: 'select_plan_viewed',
  selectPlanAccountTypeChanged: 'select_plan_account_type_changed',
  selectPlanTrialContinueClicked: 'select_plan_trial_continue_clicked',
  selectPlanDismissed: 'select_plan_dismissed',
  billingPeriodChanged: 'billing_period_changed',
  upgradeViewed: 'upgrade_viewed',
  upgradeModalViewed: 'upgrade_modal_viewed',
  postSyncModalViewed: 'post_sync_modal_viewed',
  /**
   * Ask health, one trio for EVERY upgrade ask, discriminated by the `surface`
   * field (not a per-surface event name — that is the fragmentation this file's
   * header records). Surfaces: upgrade_banner, post_sync_modal, third_brief,
   * history_trim, project_cap. Emitted only through lib/upgradeOffer.ts, which
   * sends the same name to both sinks.
   *
   * Without these, an ask that converts and an ask that merely annoys produce
   * the same silence. shown vs clicked vs dismissed per surface is what lets a
   * surface be demoted on evidence (§10: <2% click after 100 shows).
   */
  upgradeOfferShown: 'upgrade_offer_shown',
  upgradeOfferClicked: 'upgrade_offer_clicked',
  upgradeOfferDismissed: 'upgrade_offer_dismissed',
  checkoutPageViewed: 'checkout_page_viewed',
  checkoutStarted: 'checkout_started',
  checkoutCanceledViewed: 'checkout_canceled_viewed',
  purchaseCompleted: 'purchase_completed',
  // A Team buyer left the success modal INTO the team wizard rather than
  // dismissing it — the first observable step of admin onboarding, and the
  // client-side leading indicator for the server's team_activated.
  teamSetupStarted: 'team_setup_started',

  // ── Referral / viral ───────────────────────────────────────────────────────
  // (link_landed fires client-side on marketing; signup / activated / reward_granted
  // are emitted server-side from referralService.)
  referPageViewed: 'refer_page_viewed',
  referralLinkCopied: 'referral_link_copied',
  referralLinkLanded: 'referral_link_landed',
  referralSignup: 'referral_signup',
  referralActivated: 'referral_activated',
  referralRewardGranted: 'referral_reward_granted',
} as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS];
