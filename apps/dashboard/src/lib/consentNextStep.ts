/**
 * What the person does after approving a connection (E-037, 2026-10-03).
 *
 * A hosted connector sends DeerDawn nothing at approval. Its first request
 * arrives when the person next uses DeerDawn in a chat. From 09-25 to 10-03,
 * 13 real approvers got a working token and 9 of them never sent a single
 * request. The screen they approved on told them their context "will be
 * available to this tool automatically", which reads as "there is nothing left
 * to do". So it now says the one step that is left.
 *
 * The tool is named only for a verified client we name everywhere else
 * (ChatGPT, Claude). A self-registered client's name is whatever it registered,
 * so it never reaches this sentence. Same rule as `clientLabel` in the API's
 * activation follow-up email.
 *
 * 2026-10-06: the step is now a message that fills the brief, not one that
 * only opens a session. 22 of 23 real signups in the 30 days to 10-06 were
 * made on this screen, which skips onboarding, so their first start_session
 * found an empty account and got an interview instead of a brief. ChatGPT and
 * Claude already know the person's projects from earlier chats; this message
 * asks them to put that into DeerDawn, so session one ends with real projects
 * saved and session two opens briefed. Connect copies it (the click is the
 * clipboard gesture), so the screen gains no step.
 */
export const CONSENT_FIRST_PROMPT =
  "Add the projects I'm working on to DeerDawn. Use what you know about me and our earlier chats: " +
  "for each project, save what it is, where it stands, decisions so far, and what's next. " +
  'Skip any DeerDawn already has, then show me what you saved.';

/**
 * Copy the first message. Call it synchronously inside the Connect click,
 * before any await: browsers (Safari most strictly) only allow a clipboard
 * write while the click's user activation is still live. Never throws; the
 * prompt is also shown on the card, so a refused copy costs a retype, not the
 * connection.
 */
export function copyFirstPrompt(): Promise<boolean> {
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') return Promise.resolve(false);
    return clipboard.writeText(CONSENT_FIRST_PROMPT).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function consentToolLabel(clientName: string | null | undefined, verified: boolean): string | null {
  if (!verified) return null;
  const name = String(clientName || '');
  if (/chatgpt|openai/i.test(name)) return 'ChatGPT';
  if (/claude/i.test(name)) return 'Claude';
  return null;
}
