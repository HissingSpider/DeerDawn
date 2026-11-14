import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ArchivedProjectLike } from '@/lib/archivedProjects';

/**
 * Is this page empty because every project is ARCHIVED?
 *
 * Today, Projects and Board ask this before choosing their empty state (journey
 * r3, A1). /portfolio and /memory did not: with every project archived they
 * said "No decisions recorded yet" and "Nothing briefed yet" over work that is
 * archived, not gone. Asked only while the page's own content is empty
 * (`enabled`), so a page with something on it makes no extra request; the
 * archive is read only when the active list is empty too, exactly as on the
 * other pages. A failed ask says what the page said before: null.
 */
export function useArchivedOnly(enabled: boolean): ArchivedProjectLike[] | null {
  const [archived, setArchived] = useState<ArchivedProjectLike[] | null>(null);
  useEffect(() => {
    if (!enabled) {
      setArchived(null);
      return undefined;
    }
    let cancelled = false;
    api.getContextProjects()
      .then(async (active) => {
        if (cancelled || active.length > 0) return;
        const rows = await api.getArchivedContextProjects();
        if (!cancelled) setArchived(rows.length > 0 ? rows : null);
      })
      .catch(() => { /* the page's own empty state stands */ });
    return () => { cancelled = true; };
  }, [enabled]);
  return archived;
}
