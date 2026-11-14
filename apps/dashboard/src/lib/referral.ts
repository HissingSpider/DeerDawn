import { PRO_PLAN_NAME } from '@/lib/planCopy';
import { siteConfig } from '@/lib/siteConfig';

// Share a clickable LINK, never a bare code. The marketing signup parses
// ?referral_code; the new account gets its Pro month at signup and the sender
// gets theirs when that account's first brief syncs. So this URL is
// redeemable with one click — no "where do I paste this code?" friction.
export function buildInviteLink(code: string): string {
  return `${siteConfig.ACTIVE_SITE_URL}/signup?referral_code=${encodeURIComponent(code)}`;
}

// Pre-written so the sender doesn't have to compose anything — the single
// biggest lever on share rate is removing the work from the sender.
export function buildInviteMessage(code: string): string {
  const link = buildInviteLink(code);
  return `I use DeerDawn to keep Claude, Cursor, Codex & ChatGPT in sync on my projects — set up once and every tool stays caught up. Grab a free month of ${PRO_PLAN_NAME} on me: ${link}`;
}
