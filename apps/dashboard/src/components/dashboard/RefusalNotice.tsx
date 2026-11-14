import { useState } from 'react';
import Link from 'next/link';
import { PERSONAL_SWITCH_FAILED_MESSAGE, api, getActiveWorkspace, switchToPersonalWorkspace } from '@/lib/api';
import {
  refusalCopy,
  resolveLoadFailure,
  type LoadFailure,
} from '@/lib/loadFailure';
import { InlineErrorState } from './PageScaffold';

/**
 * Classify a failed load (lib/loadFailure), and for a subscription refusal
 * learn whether this reader is the one who can fix the bill. The listing read
 * (GET /teams/workspaces) is exempt from plan enforcement, so it answers while
 * the workspace is refusing everything else; if it fails too, the reader is
 * treated as somebody who cannot update billing (mayUpdateBilling).
 *
 * Every page that loads the workspace's data calls this in its catch. A
 * failure it classifies as `unreachable` goes on to the page's own failure
 * state, unchanged; a refusal renders RefusalNotice instead.
 */
export function loadFailureFrom(error: unknown): Promise<LoadFailure> {
  return resolveLoadFailure(error, {
    readListing: () => api.getWorkspaces(),
    storedChoice: getActiveWorkspace,
  });
}

/**
 * A refused load: the reason, and the way to act on it for the reader who can.
 * No Retry: a retry sends the identical request to the identical workspace and
 * is refused identically.
 *
 * `role="status"`: it appears IN PLACE of the page's content when the page's
 * load is refused, so it arrives with the page rather than answering something
 * the reader just did. A polite region is announced after the page's own
 * announcement instead of cutting it off; `alert` is for what answers a press
 * (BillingRefusalNotice). The fallback banner is `status` for the same reason.
 *
 * The link is 40px tall on a phone: the root font is 14px, so only a pixel
 * value says 40. It is a flex item, so it can take a height as it is.
 */
export function RefusalNotice({ failure }: { failure: LoadFailure }) {
  const copy = refusalCopy(failure);
  let action = null;
  if (copy.action?.kind === 'switch_workspace') {
    action = <SwitchToOwnWorkspaceButton label={copy.action.label} />;
  } else if (copy.action?.kind === 'mailto') {
    // A mail link, not a route: a plain anchor.
    action = (
      <a
        href={copy.action.href}
        className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90 max-sm:inline-flex max-sm:min-h-[40px] max-sm:items-center"
      >
        {copy.action.label}
      </a>
    );
  } else if (copy.action) {
    action = (
      <Link
        href={copy.action.href}
        className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary no-underline hover:bg-primary/90 max-sm:inline-flex max-sm:min-h-[40px] max-sm:items-center"
      >
        {copy.action.label}
      </Link>
    );
  }
  return (
    <InlineErrorState
      role="status"
      title={copy.title}
      description={copy.description}
      requestId={failure.requestId}
      action={action}
    />
  );
}

/**
 * Somebody else's locked workspace: the way out is the person's own. The switch
 * is POST /teams/active, which the lock does not refuse, and the page reloads
 * into the workspace it moved to. If the server half fails it says so instead of
 * reloading into the same refusal (switchToPersonalWorkspace).
 */
function SwitchToOwnWorkspaceButton({ label }: { label: string }) {
  const [failed, setFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  return (
    <span className="flex flex-col gap-2">
      <button
        type="button"
        className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary hover:bg-primary/90 disabled:opacity-60 max-sm:inline-flex max-sm:min-h-[40px] max-sm:items-center"
        disabled={switching}
        onClick={() => {
          setFailed(false);
          setSwitching(true);
          void switchToPersonalWorkspace().then((switched) => {
            if (switched) {
              window.location.reload();
              return;
            }
            setSwitching(false);
            setFailed(true);
          });
        }}
      >
        {label}
      </button>
      {failed ? <span role="alert" className="text-[12px] text-status-danger-text">{PERSONAL_SWITCH_FAILED_MESSAGE}</span> : null}
    </span>
  );
}
