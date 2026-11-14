import { BrandLogo } from '@/components/BrandLogo';
import type { ReactNode } from 'react';

type WorkspaceLoadingScreenProps = {
  eyebrow?: string;
  title: string;
  description: string;
  delayed?: boolean;
  delayedLabel?: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryAction?: ReactNode;
};

export function WorkspaceLoadingScreen({ delayed, primaryHref, primaryLabel, delayedLabel }: WorkspaceLoadingScreenProps) {
  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 bg-background">
      <div className="relative h-14 w-14">
        <BrandLogo
          alt="DeerDawn"
          className="object-contain opacity-80"
          priority
          sizes="56px"
        />
      </div>

      <svg className="animate-spin text-primary" width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
        <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" className="opacity-80" />
      </svg>

      {delayed && (
        <div className="text-center">
          <p className="mb-3 text-[13px] text-text-muted">{delayedLabel || 'Taking longer than expected.'}</p>
          {primaryHref && primaryLabel && (
            <a href={primaryHref} className="text-[13px] text-primary underline">{primaryLabel}</a>
          )}
        </div>
      )}
    </div>
  );
}
