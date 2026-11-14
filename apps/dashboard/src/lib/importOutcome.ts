/**
 * What an import through /api/v1/context/seed tells the person about the
 * projects no model processed.
 *
 * When no extraction model is configured, or its call fails, the API saves
 * nothing from those conversations (the owner's decision, journey scan round
 * 4): it used to copy the person's longest message into the brief. It keeps the
 * project under the name it was sent with, empty, and lists it in
 * `not_processed` rather than counting it as created. Both import surfaces (the
 * /context/import page and the Memory page's "Add context") say so through this
 * one function, so neither can read a refused import as a success.
 */

export type SeedNotProcessed = { project: string; project_id: string | null };

export type SeedResult = {
  projects_created?: number;
  projects_skipped?: number;
  projects_not_processed?: number;
  not_processed?: SeedNotProcessed[];
  errors?: { project: string; error: string }[];
};

/** The projects an import could not process. Empty for an API that predates the list. */
export function notProcessedOf(result: SeedResult | null | undefined): SeedNotProcessed[] {
  return Array.isArray(result?.not_processed) ? result.not_processed : [];
}

function quoted(names: string[]): string {
  const q = names.map((name) => `“${name}”`);
  if (q.length <= 1) return q.join('');
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/**
 * The sentences for the projects that were not processed, or null when every
 * project was. States what happened, what was and was not saved, and what to do.
 */
export function notProcessedMessage(result: SeedResult | null | undefined): string | null {
  const items = notProcessedOf(result);
  if (items.length === 0) return null;
  const one = items.length === 1;
  const names = quoted(items.map((item) => item.project));
  const kept = items.filter((item) => item.project_id);
  const keptLine = kept.length === 0
    ? ''
    : kept.length === items.length
      ? one
        ? ' The project is kept under its name, with an empty brief.'
        : ' The projects are kept under their names, with empty briefs.'
      : ` ${quoted(kept.map((item) => item.project))} ${kept.length === 1 ? 'is' : 'are'} kept under ${kept.length === 1 ? 'its name, with an empty brief' : 'their names, with empty briefs'}.`;
  return `The conversations for ${names} could not be processed, so nothing from them was saved.${keptLine} Please try the import again.`;
}

/**
 * What an import through /seed did, for the Memory page's "Add context" modal.
 *
 * `saved`: at least one project was created from what was sent.
 * `not_processed`: no model processed it, nothing was saved (the round 4 rule).
 * `failed`: the API tried and could not save any project. Not a success, and
 * not "no new context": the person is told and can try again.
 * `nothing`: the text was too thin to keep. Nothing was saved and nothing failed.
 */
export type ImportVerdict = 'saved' | 'not_processed' | 'failed' | 'nothing';

export function importVerdict(result: SeedResult | null | undefined): ImportVerdict {
  if ((result?.projects_created ?? 0) > 0) return 'saved';
  if (notProcessedOf(result).length > 0) return 'not_processed';
  if (Array.isArray(result?.errors) && result.errors.length > 0) return 'failed';
  return 'nothing';
}

/** How many projects the API tried and could not save. */
export function failedCount(result: SeedResult | null | undefined): number {
  return Array.isArray(result?.errors) ? result.errors.length : 0;
}

/** The sentence for a failed import, or for the projects a partial import lost. */
export function failedMessage(n: number, savedSome: boolean): string {
  const noun = `${n} project${n === 1 ? '' : 's'}`;
  return savedSome
    ? `${noun} could not be saved.`
    : `Nothing was saved: ${noun} could not be saved. Please try again.`;
}
