import Link from 'next/link';
import { archivedProjectsCopy, RESTORE_ROUTE, type ArchivedProjectLike } from '@/lib/archivedProjects';

/**
 * Shown in place of an empty state when nothing is active but projects are
 * archived: how many, that they are archived and not gone, and the way to
 * where they are restored. Renders nothing when nothing is archived, so a
 * genuinely new account keeps its own empty state.
 *
 * The action is one link from every page, to the project manager on
 * /projects opened on arrival (BriefWorkspace reads `manage=archived`), which
 * is where Restore lives.
 */
export function ArchivedProjectsNotice({ archived }: { archived: ArchivedProjectLike[] | null | undefined }) {
  const copy = archivedProjectsCopy(archived);
  if (!copy) return null;
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-5 max-sm:p-4">
      <h2 className="text-xl font-semibold tracking-[-0.02em] text-text-primary max-sm:text-lg">
        {copy.headline}
      </h2>
      {copy.names ? (
        <p className="mt-2 max-w-xl text-sm font-medium leading-6 text-text-primary">{copy.names}</p>
      ) : null}
      <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">{copy.body}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <Link
          href={RESTORE_ROUTE}
          className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90 max-sm:inline-flex max-sm:min-h-[40px] max-sm:items-center"
        >
          {copy.actionLabel}
        </Link>
      </div>
    </div>
  );
}
