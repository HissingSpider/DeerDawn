import { apiErrorReason, isApiError } from './api';

/**
 * What to tell somebody whose skill write was REFUSED.
 *
 * The API answers a refused skill write with `skill_write_forbidden` and a
 * sentence saying why: a read-only role, or somebody else's skill. Every catch
 * on the skills page rendered that as "Failed to save/update/delete skill", which
 * reads as a fault to retry, so people retried a thing that can never succeed.
 * Returns null for anything that is not a refusal, so the caller keeps its own
 * message for real failures.
 */
export function skillRefusalMessage(error: unknown): string | null {
  if (apiErrorReason(error) !== 'skill_write_forbidden') return null;
  const said = isApiError(error) && typeof error.data?.message === 'string' ? error.data.message.trim() : '';
  return said || 'Only the person who wrote this skill, or a workspace owner, can change it.';
}

/**
 * May this person change this skill? Drives whether the card offers Edit,
 * Delete and the enable switch at all: every one of them is a write, and a
 * colleague's skill used to take the whole edit before answering that it was
 * never theirs to change. Only an explicit `false` hides anything.
 */
export function canEditSkill(skill: { can_edit?: boolean }): boolean {
  return skill.can_edit !== false;
}
