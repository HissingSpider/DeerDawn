import type { BriefTrust } from './api';

/**
 * The words a brief line's trust pill uses.
 *
 * A SHIPPED line that came from a board card moved to Done (`fromCard`) is labelled
 * "Shipped". It reads as high trust everywhere else (confidence 1, so it sorts and
 * filters with the confirmed lines), but "Verified" was wrong about it: a card in
 * the Done column is a completion somebody reported, and nobody checked it. Every
 * other line keeps the label it had.
 */
export function provenanceLabel(trust: BriefTrust, fromCard = false): string {
  if (fromCard) return 'Shipped';
  return { high: 'Verified', inferred: 'Inferred', unverified: 'Unverified' }[trust];
}

export function provenanceTitle(trust: BriefTrust, fromCard = false): string {
  if (fromCard) return 'Shipped: this card was moved to Done. It says the work was reported finished, not that anyone checked it.';
  return {
    high: 'Verified or high-confidence — a later session confirmed this, or it was captured with high confidence.',
    inferred: 'Inferred — derived from context or stamped with an inferred date; treat as a lead, not a fact.',
    unverified: 'Unverified — captured without confirmation. Confirm before relying on it.',
  }[trust];
}
