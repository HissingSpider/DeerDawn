import { useEffect, useState } from 'react';
import { onWorkspaceListing } from '@/lib/api';
import {
  rememberWorkspaceNames,
  removalNoticeText,
  takeRemovalNotice,
  type RemovalNotice,
} from '@/lib/workspaceRemoval';

/**
 * Said once, after a tab reloaded because the person was removed from the team
 * it showed (lib/workspaceRemoval). Without it the reload looked like the page
 * losing its workspace for no reason.
 *
 * It also keeps the names of the workspaces this tab has been shown, so the
 * sentence can name the team: after the removal the listing no longer has it.
 */
export function WorkspaceRemovedNotice() {
  const [notice, setNotice] = useState<RemovalNotice | null>(null);

  useEffect(() => {
    setNotice(takeRemovalNotice());
    return onWorkspaceListing((listing) => rememberWorkspaceNames(listing?.workspaces));
  }, []);

  if (!notice) return null;

  return (
    <div role="status" className="border-b border-border-subtle bg-overlay-subtle px-4 py-3 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-[13px] leading-6 text-text-primary">{removalNoticeText(notice)}</p>
        <button
          type="button"
          onClick={() => setNotice(null)}
          className="min-h-10 rounded-md border border-border-subtle px-3 text-[13px] font-medium text-text-secondary hover:text-text-primary sm:min-h-0 sm:py-1"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
