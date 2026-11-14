/**
 * Bring a notice that answers a press to where the person is, and put focus on it.
 *
 * A refusal notice is rendered where the page keeps its messages, which is not
 * always near the button that was pressed: on /settings/upgrade it sits above
 * the plan cards, and on a phone the cards stack, so "Upgrade to Team" was up
 * to 1,180px below it. Nothing moved, the button became pressable again, and
 * focus fell to the page body because the button had been disabled while it
 * waited.
 *
 * Focus goes to the notice (it must carry tabIndex={-1}), without the browser's
 * own scroll, and then the notice is scrolled to the NEAREST edge that shows it
 * whole. For a notice already on screen that moves nothing, so a layout where
 * the notice was always visible (every desktop page) stays exactly as it was.
 *
 * Takes anything with focus() and scrollIntoView() so it can be tested without
 * a DOM. Returns whether there was an element to reveal.
 */
export interface RevealTarget {
  focus(options?: { preventScroll?: boolean }): void;
  scrollIntoView(options?: { block?: 'start' | 'center' | 'end' | 'nearest'; inline?: 'start' | 'center' | 'end' | 'nearest' }): void;
}

export function revealNotice(target: RevealTarget | null | undefined): boolean {
  if (!target) return false;
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}
