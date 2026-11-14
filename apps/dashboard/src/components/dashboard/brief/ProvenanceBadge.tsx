import { Badge } from '@/components/ui/Badge';
import type { BriefTrust } from '@/lib/api';
import { provenanceLabel, provenanceTitle } from '@/lib/provenance';

// Per-item trust pill, one vocabulary across every surface:
//   high       — verified or high-confidence (green / success)
//   inferred   — derived / mid-confidence    (amber / warning)
//   unverified — unconfirmed                  (neutral)
// Trust is derived client-side today (deriveItemTrust) and read straight from
// Phase A's brief_spine once it ships.
const VARIANTS: Record<BriefTrust, 'success' | 'warning' | 'neutral'> = {
  high: 'success',
  inferred: 'warning',
  unverified: 'neutral',
};

export function ProvenanceBadge({ trust, fromCard = false }: { trust: BriefTrust; fromCard?: boolean }) {
  return (
    <span title={provenanceTitle(trust, fromCard)}>
      <Badge variant={VARIANTS[trust]} size="sm">
        {provenanceLabel(trust, fromCard)}
      </Badge>
    </span>
  );
}
