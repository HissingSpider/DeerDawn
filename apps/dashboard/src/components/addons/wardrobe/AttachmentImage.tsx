import { useEffect, useState } from 'react';
import { addonAttachmentUrl, type AddonVariant } from './platformClient';
import { ADDON_ID } from './types';

// addonAttachmentUrl fetches with auth and caches the object URL, so the grid,
// the item panel and the outfit cards share one download per photo and variant.
export function AttachmentImage({
  attachmentId,
  variant = 'thumb',
  alt,
  className = '',
}: {
  attachmentId: string | null | undefined;
  variant?: AddonVariant;
  alt: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState<{ key: string; src: string | null; failed: boolean } | null>(null);
  const key = attachmentId ? `${attachmentId}:${variant}` : '';

  useEffect(() => {
    if (!attachmentId) return;
    let live = true;
    const k = `${attachmentId}:${variant}`;
    addonAttachmentUrl(ADDON_ID, attachmentId, variant).then(
      (src) => live && setLoaded({ key: k, src, failed: false }),
      () => live && setLoaded({ key: k, src: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [attachmentId, variant]);

  const current = loaded && loaded.key === key ? loaded : null;
  if (!attachmentId || current?.failed) {
    return (
      <div className={`flex items-center justify-center bg-overlay-subtle text-[11px] text-text-muted ${className}`} role="img" aria-label={alt}>
        {attachmentId ? 'Photo unavailable' : 'No photo'}
      </div>
    );
  }
  if (!current?.src) return <div className={`animate-pulse bg-overlay-subtle ${className}`} aria-hidden="true" />;
  // eslint-disable-next-line @next/next/no-img-element -- blob: URL from an authenticated fetch; next/image cannot optimise it
  return <img src={current.src} alt={alt} className={`object-cover ${className}`} />;
}
