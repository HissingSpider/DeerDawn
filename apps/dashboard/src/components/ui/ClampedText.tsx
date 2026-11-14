import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Text that is allowed to be long without being allowed to wreck the layout.
 *
 * THE PROBLEM IT FIXES: brief entries are written by a model summarising a
 * working session, and they are not uniform. Most are a sentence. Some are six
 * hundred words — a full changelog with commit SHAs, file paths and rationale.
 * Rendered unbounded inside a two-column grid, ONE of those makes its column
 * four thousand pixels tall while the column beside it is four hundred. Nothing
 * lines up, the "N more" footers end up screens apart, and the page cannot be
 * scanned at all. The content was right; the container had no opinion.
 *
 * WHY MEASURE INSTEAD OF COUNTING CHARACTERS. A character threshold guesses.
 * The same 300 characters is two lines on a wide desktop column and eight on a
 * phone, so a guess either clamps text that fits (and offers a pointless
 * "Show more") or fails to clamp text that doesn't. This compares `scrollHeight`
 * against `clientHeight` on the real, laid-out element, and re-checks on resize
 * and on font load, so the control appears exactly when there is something
 * hidden.
 *
 * `-webkit-line-clamp` does the clipping. It is the one clamp that ends the last
 * visible line with an ellipsis, which is the signal that there is more —
 * `max-height` cuts at the same pixel but leaves a line that looks complete.
 * Verified in the browser that `scrollHeight` still reports the FULL content
 * height through it (60px shown, 262px real), so the overflow test below is
 * sound; that is worth stating because the opposite is often assumed.
 *
 * The font matters: `next/font` swaps from the fallback after first paint and
 * the two do not wrap identically, so the measurement is repeated once fonts
 * settle rather than trusted from the first layout pass.
 *
 * Deliberately NOT a fade-out gradient — the house rule is no gradients, and a
 * hard clamp with a labelled control is more honest anyway: it says how to see
 * the rest instead of implying the text merely trails off.
 */
export function ClampedText({
  text,
  lines = 3,
  className = '',
  moreLabel = 'Show more',
  lessLabel = 'Show less',
}: {
  text: string;
  /** Visible lines before clamping. */
  lines?: number;
  className?: string;
  moreLabel?: string;
  lessLabel?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    // Only meaningful while clamped: expanded, scrollHeight === clientHeight by
    // definition, so measuring then would decide the text no longer overflows
    // and remove the control the reader needs to collapse it again.
    if (!el || expanded) return;
    setOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [expanded]);

  useLayoutEffect(measure, [measure, text, lines]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The webfont replaces the fallback after first paint and the two do not
    // wrap identically, so a measurement taken before that can be wrong in
    // either direction. Re-run once when fonts settle.
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    }).catch(() => { /* no font API: the layout-effect measurement stands */ });

    if (typeof ResizeObserver === 'undefined') return () => { cancelled = true; };
    // Width drives line count, so a column resize changes the answer. Observing
    // the element covers both viewport resizes and a sibling panel expanding.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [measure]);

  return (
    <>
      <p
        ref={ref}
        className={className}
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: lines,
                overflow: 'hidden',
              }
        }
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11.5px] font-medium text-text-muted underline-offset-2 transition-colors hover:text-text-secondary hover:underline"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </>
  );
}
