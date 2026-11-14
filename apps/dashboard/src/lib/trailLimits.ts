/**
 * How large a .dawn the Trail import will actually accept.
 *
 * THE BUG. /trails refused files over 5 MB and said "Trails are normally a few
 * hundred kilobytes." The API accepts 200,000 CHARACTERS of trail contents
 * (`z.string().max(MAX_TRAIL_CHARS)` on POST /api/v1/context/trail/import), so
 * every file between those two numbers was uploaded, spent the round trip, and
 * came back as a raw Zod 400 — a machine-shaped refusal for a limit the page
 * had already told the user was twenty-five times higher.
 *
 * MIRRORED, NOT IMPORTED. packages/shared-context is CommonJS and is not a
 * dependency of this app, so the number is restated here and trailLimits.test.ts
 * reads that package's source and fails if the two ever drift — the same
 * arrangement planCopy has with plans.js. Source of truth:
 * packages/shared-context/src/index.js, `const MAX_TRAIL_CHARS = 200_000`.
 */
export const MAX_TRAIL_CHARS = 200_000;

/**
 * A byte ceiling for refusing a file WITHOUT reading it.
 *
 * The API's limit is in characters and the browser only knows bytes until the
 * file has been read, and UTF-8 spends at most four bytes on a character — so
 * anything above this cannot fit however it is encoded, and anything below it
 * still has to be measured after reading. Checking bytes alone would refuse a
 * legitimate multi-byte archive.
 */
export const MAX_TRAIL_BYTES_CEILING = MAX_TRAIL_CHARS * 4;

/** Does this trail exceed what the import will take? Measured in characters,
 *  because that is what the server measures. */
export function trailTooLarge(charCount: number): boolean {
  return charCount > MAX_TRAIL_CHARS;
}

/** The refusal, in the same number the server would refuse it with. */
export function describeTrailTooLarge(charCount?: number): string {
  const size = typeof charCount === 'number' && Number.isFinite(charCount)
    ? `That Trail is ${Math.round(charCount).toLocaleString()} characters. `
    : 'That Trail is too large. ';
  return `${size}The import accepts up to ${MAX_TRAIL_CHARS.toLocaleString()}, so it would be refused. `
    + 'Most Trails are 8 to 30 KB; export a single project rather than a whole workspace.';
}
