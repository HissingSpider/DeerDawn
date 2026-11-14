import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { showToast } from '@/components/ui/Toast';

/**
 * An invitation link with a copy button.
 *
 * Shown whenever the server did not confirm that the invitation email left, so
 * the owner can send the link themselves instead of assuming it arrived.
 */
export function InviteLinkCopy({ link, label }: { link: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Could not copy. Select the link and copy it manually.', 'error');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {label && <span className="w-full text-xs text-text-secondary">{label}</span>}
      <code className="min-w-0 flex-1 break-all rounded-md border border-border-subtle bg-overlay-subtle px-2 py-1.5 text-xs text-text-muted">
        {link}
      </code>
      <Button type="button" variant="secondary" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy link'}
      </Button>
    </div>
  );
}
