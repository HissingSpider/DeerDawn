/**
 * What should happen when someone clicks "Continue with Google".
 *
 * MIRROR of apps/marketing/src/lib/oauthStart.ts, which is the source of truth
 * and carries the full reasoning. The two implementations are pinned
 * byte-for-byte (comments aside) by
 * apps/marketing/tests/auth-already-signed-in.test.js — the surfaces have
 * drifted apart on exactly this decision twice now, so a copy that can quietly
 * disagree is the failure mode, not the duplication.
 *
 * The short version:
 *
 * RULE 1 — never START an OAuth attempt against a live session. Clerk refuses
 * it, and the refusal has two shapes: one throws client-side (catchable) and
 * one is rejected by Clerk's callback SERVER-side, which lands the user on a raw
 * `authorization_invalid` JSON page that no catch block can recover from,
 * because the browser has already navigated away.
 *
 * RULE 2 — a live session is a QUESTION, not an answer. Redirecting into the
 * session silently is right for "I forgot I was signed in" and wrong for "I
 * want a different account"; the click names no identity, so neither reading can
 * be inferred and neither may be resolved destructively. Ask, naming the
 * account, then act.
 *
 * Why the dashboard needs its own copy of this at all: #361 fixed the marketing
 * modal and left this app calling authenticateWithRedirect unguarded, relying on
 * the mount effect in ClerkAuthPage to bounce signed-in users before they can
 * click. That effect is a `router.replace` in a `useEffect` — a click landing in
 * the gap between Clerk hydrating and the navigation completing still reached
 * the unguarded call, and did, in production, on 2026-08-28. That gap is also
 * the only window in which this app shows the prompt at all: everywhere else,
 * the mount effect has already moved a signed-in user on, and switching accounts
 * from inside the app is what the shell's "Log out" is for.
 */
export type OAuthStart =
  /**
   * A session already exists, and the click has not said which of two things it
   * meant. Ask — naming the identity — before doing anything irreversible.
   */
  | { action: 'confirm'; identity?: string; continueUrl: string; prompt: string; continueLabel: string; switchLabel: string }
  /** The user has answered "a different account": drop the session, then OAuth. */
  | { action: 'switch' }
  /** No session — start the Clerk OAuth redirect as normal. */
  | { action: 'oauth' };

/** The `confirm` branch, for callers that hold it in state while they ask. */
export type OAuthAccountPrompt = Extract<OAuthStart, { action: 'confirm' }>;

export function resolveOAuthStart(input: {
  isSignedIn: boolean | undefined;
  isSignup: boolean;
  identity?: string | null;
  confirmedSwitch?: boolean;
  loginRedirectUrl: string;
  signupRedirectUrl: string;
}): OAuthStart {
  const { isSignedIn, isSignup, identity, confirmedSwitch, loginRedirectUrl, signupRedirectUrl } = input;

  // `undefined` means Clerk has not loaded yet. Treat it as "not signed in" and
  // let the normal flow run: guessing "signed in" here would ask a genuinely
  // signed-out user which account they meant, which is nonsense.
  //
  // This is checked FIRST so that a confirmed switch whose session has since
  // gone away (signed out in another tab) skips the redundant signOut.
  if (isSignedIn !== true) return { action: 'oauth' };

  // Answered. Now the signal names an identity as squarely as a typed email
  // does, so it gets the same resolution the email path gives: tear the stale
  // session down and run the attempt.
  if (confirmedSwitch === true) return { action: 'switch' };

  const named = typeof identity === 'string' ? identity.trim() : '';
  return {
    action: 'confirm',
    identity: named || undefined,
    continueUrl: isSignup ? signupRedirectUrl : loginRedirectUrl,
    // The copy is built HERE, not in the two components, for the same reason
    // the decision is: it is the part most likely to drift, and the byte-pin in
    // apps/marketing/tests/auth-already-signed-in.test.js already covers this
    // file. Naming the account is the whole point — "silently in the wrong
    // dashboard, with no indication why" is the bug being fixed.
    prompt: named
      ? `You’re already signed in as ${named}. Continue with that account, or sign out and pick a different Google account.`
      : 'You’re already signed in on this browser. Continue with that account, or sign out and pick a different Google account.',
    continueLabel: named ? `Continue as ${named}` : 'Continue to your workspace',
    switchLabel: 'Sign out and use a different Google account',
  };
}
