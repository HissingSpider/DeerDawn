/**
 * Entitlements follow the WORKSPACE, never the person's own org.
 *
 * An invited teammate's users.org_id is still their own personal org — usually
 * Free — so an entitlement lookup keyed on actor.org_id refuses a paid Team's
 * members the Team's own features. Scan 11 (2026-09-22) found three sites doing
 * it (cross-project decisions, share links, skills) beside a portfolio that got
 * it right. The behavioural pin is tests/integration/scan11-context-teams.test.js;
 * this one stops the shape coming back in the files it came from.
 *
 * Comment-blind: the comments explaining the rule mention org_id on purpose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const FILES = [
  'services/crossProjectService.js',
  'services/shareService.js',
  'services/portfolioService.js',
  'routes/context/context-sync.js',
];
const LOOKUP = /\b(getEntitlements|getEntitlementsForExistingOrg|getSkillEntitlements|getOwnerEntitlements)\s*\(([^)]*)\)/g;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function entitlementViolations(source) {
  const code = stripComments(source);
  const out = [];
  for (const match of code.matchAll(LOOKUP)) {
    const [call, fn, arg] = match;
    if (/function\s+$/.test(code.slice(Math.max(0, match.index - 20), match.index))) continue; // a definition
    if (/org_id/.test(arg)) { out.push(call); continue; }
    const ident = arg.trim().match(/^[A-Za-z_$][\w$]*$/)?.[0];
    if (!ident) continue;
    // The variable handed to the lookup must not be derived from org_id either.
    const assign = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*([^;]*);`, 'g');
    for (const a of code.matchAll(assign)) {
      if (/org_id/.test(a[1])) out.push(`${fn}(${ident}) where ${ident} = ${a[1].trim()}`);
    }
  }
  return out;
}

test('the scanner catches the shapes it exists for, and ignores comments', () => {
  assert.equal(entitlementViolations('const e = await getSkillEntitlements(req.actor?.org_id || ownerKey);').length, 1);
  assert.equal(entitlementViolations('const ownerKey = actor?.org_id || getActorKey(actor);\nawait getEntitlementsForExistingOrg(ownerKey);').length, 1);
  assert.equal(entitlementViolations('const ownerKey = getActorKey(actor);\nawait getEntitlementsForExistingOrg(ownerKey);').length, 0);
  assert.equal(entitlementViolations('// getEntitlements(actor.org_id) was wrong\nawait getEntitlements(ownerKey);').length, 0);
});

test('entitlement lookups in the scan-11 files are keyed on the workspace, not actor.org_id', () => {
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    assert.deepEqual(entitlementViolations(source), [], `${file} reads entitlements from the person's own org`);
  }
});
