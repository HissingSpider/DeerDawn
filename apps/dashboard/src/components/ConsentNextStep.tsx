import { CONSENT_FIRST_PROMPT, consentToolLabel } from '@/lib/consentNextStep';

/**
 * The step after Connect, said before it. Connect itself copies the message. See lib/consentNextStep for why the
 * old "available to this tool automatically" sentence had to go.
 */
export function ConsentNextStep({ clientName, verified }: { clientName: string | null | undefined; verified: boolean }) {
  const tool = consentToolLabel(clientName, verified);
  return (
    <div
      data-testid="consent-next-step"
      className="mb-6 rounded-xl border border-primary/20 bg-primary/[0.07] p-4 text-[13px] leading-[1.6] text-text-secondary"
    >
      <p className="m-0 font-semibold text-text-primary">Connect copies your first message</p>
      <p className="mb-0 mt-1.5">
        Then start a new chat in {tool || 'your AI tool'} with DeerDawn switched on, and paste it:
      </p>
      <p className="mb-0 mt-2 rounded-lg border border-border-subtle bg-overlay-active px-3 py-2 font-mono text-[12px] text-text-primary">
        {CONSENT_FIRST_PROMPT}
      </p>
      <p className="mb-0 mt-2">
        It saves the projects {tool || 'your AI tool'} already knows about, so your next chat starts briefed. You can revoke access any time from your dashboard settings.
      </p>
    </div>
  );
}
