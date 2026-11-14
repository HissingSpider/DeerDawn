// THE LEAVE SCREEN AND THE OWNER'S REMOVE CONFIRMATION SAY WHAT STAYS.
//
// Journey r5 (round 2 BLOCKED 14): a decision, question, board card, line of
// context or entity somebody wrote into a team's shared project stays with the
// team when they leave or are removed. The confirmations only said "everything
// you contributed stays here", so a person found out afterwards that they could
// no longer take a note back. Both now say, before it happens, what stays with
// the team and what goes with the person, in the delete-account dialog's two
// parts.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const load = async () => {
  try { return await import('./workspaceRemoval'); } catch { return {} as Record<string, any>; }
};

test('leaving: says what stays with the team, in plain words, before it happens', async () => {
  const m = await load();
  assert.strictEqual(typeof m.leaveWorkspaceConfirmText, 'function', 'THE BUG: the leave screen had no such sentence');
  const text: string = m.leaveWorkspaceConfirmText();
  assert.match(text, /^Leave this workspace\?/);
  assert.match(text, /Stays with the team: everything you wrote into its shared projects, such as decisions, open questions, board cards, lines of context and entities\./);
  assert.match(text, /It stays credited to you\. You cannot change it after you leave\. The project’s author can delete it, and so can a workspace owner once the author has left\./);
  assert.doesNotMatch(text, /a workspace owner can delete it\./, 'no unconditional promise to the team\'s owners');
  assert.match(text, /Goes with you: your personal projects and your profile/);
  assert.match(text, /API keys for this workspace are revoked now/);
  assert.match(text, /Nothing in any other workspace changes\./);
});

test('removing: an owner is told the same two things about the person they remove', async () => {
  const m = await load();
  assert.strictEqual(typeof m.removeMemberConfirmText, 'function');
  const text: string = m.removeMemberConfirmText('lee@example.test');
  assert.match(text, /^Remove lee@example\.test from this workspace\?/);
  assert.match(text, /Stays with the team: everything they wrote into its shared projects, such as decisions, open questions, board cards, lines of context and entities\./);
  assert.match(text, /It stays credited to them\. A workspace owner can delete it once the project’s author has left; until then its author can\./);
  assert.doesNotMatch(text, /you can delete it afterwards/, 'no unconditional promise to the owner');
  assert.match(text, /Goes with them: their personal projects and their profile/);
  assert.match(text, /API keys for this workspace are revoked now/);
});

test('neither says anything the leaving does not do', async () => {
  const m = await load();
  for (const text of [m.leaveWorkspaceConfirmText?.(), m.removeMemberConfirmText?.('x')] as string[]) {
    assert.ok(text, 'both exist');
    // Personal things move; nothing is said to be deleted or erased.
    assert.doesNotMatch(text, /\b(deleted|erased|wiped)\b/i);
    // No emoji, no gradients.
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
  }
});

test('the Team page shows exactly these sentences', () => {
  const team = readFileSync(join(__dirname, '../pages/settings/team.tsx'), 'utf8');
  assert.match(team, /window\.confirm\(leaveWorkspaceConfirmText\(\)\)/, 'the leave button confirms with the sentence');
  assert.match(team, /window\.confirm\(removeMemberConfirmText\(label\)\)/, 'the owner\'s remove button confirms with the sentence');
  assert.doesNotMatch(team, /Everything (you|they) contributed/, 'the vague line is gone');
});
