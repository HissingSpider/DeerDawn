import type { ConsentWorkspace } from '@/lib/consentWorkspace';

/**
 * "This connection will work in <workspace>", on the consent screen.
 *
 * Permanent, so it is said before the button rather than discovered after: a
 * hosted connection stays in the workspace it is approved from, and using the
 * tool in another one means approving it again there. When the workspace could
 * not be read the sentence still says the true part instead of guessing a name.
 */
export function ConsentWorkspaceNotice({ workspace }: { workspace: ConsentWorkspace | null }) {
  return (
    <div
      data-testid="consent-workspace"
      className="mb-6 rounded-xl border border-border-subtle bg-overlay-active p-4 text-[13px] leading-[1.6] text-text-secondary"
    >
      {workspace ? (
        <>
          This connection will work in <span className="break-words font-semibold text-text-primary">{workspace.name}</span>
          , and only there.
        </>
      ) : (
        <>This connection will work in the workspace you are in now, and only there.</>
      )}
      {' '}To use it in another workspace, approve it again from that workspace.
    </div>
  );
}
