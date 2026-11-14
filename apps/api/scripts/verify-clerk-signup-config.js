#!/usr/bin/env node
'use strict';

/**
 * Clerk signup-config contract check.
 *
 * The marketing signup form (apps/marketing/src/components/MarketingAuthForm.tsx)
 * calls signUp.create({ emailAddress, password, unsafeMetadata }) — email +
 * password ONLY. Names are collected later in onboarding, by design (the
 * front-door form is a conversion lever). If the Clerk instance is ever
 * configured to REQUIRE a field the form doesn't submit (e.g. first_name /
 * last_name flipped to required, or email verification turned on), every signup
 * silently fails with `status: missing_requirements` — with no code change and
 * nothing in CI to catch it. That exact drift took signup down on 2026-07-04.
 *
 * This asserts the live Clerk instance config still matches what the form sends:
 *   - every REQUIRED signup attribute must be one the form actually submits
 *   - if email requires verification at sign-up, BOTH signup surfaces must
 *     implement a verification step
 *
 * That second rule used to read "email must NOT require verification, because
 * the form has no verify step". Verification was switched on at the instance on
 * 2026-08-26 and #354 added the step to both surfaces — so the old rule became
 * an assertion that the product was still in its previous shape, and failed
 * every run from then on while signup was in fact healthy. It is now a
 * two-sided contract: verification on + step present is a pass, and removing
 * the step while Clerk still requires it re-breaks signup and fails here.
 *
 * Read-only: fetches the public Clerk Frontend-API `environment` endpoint. No
 * writes, no test accounts. Exits non-zero on drift so verify-prod / a monitor
 * goes red. Override the instance with CLERK_FAPI_URL.
 */

const fs = require('node:fs');
const path = require('node:path');

const CLERK_FAPI_URL = process.env.CLERK_FAPI_URL || 'https://clerk.deerdawn.com';

const REPO_ROOT = path.resolve(__dirname, '../../..');

// The signup surfaces that must handle a `missing_requirements` response by
// verifying the email address, whenever the instance requires verification.
const VERIFY_SURFACES = [
  'apps/marketing/src/components/MarketingAuthForm.tsx',
  'apps/dashboard/src/components/ClerkAuthPage.tsx',
];

// A surface implements the step when it both requests the code and submits it.
// Checking only `prepare…` would pass a surface that emails a code and then
// drops the user on a screen with nowhere to enter it.
function implementsVerificationStep(relPath) {
  try {
    const src = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    return src.includes('prepareEmailAddressVerification')
      && src.includes('attemptEmailAddressVerification');
  } catch {
    return null; // unreadable — reported separately from "absent"
  }
}

// Exactly the fields MarketingAuthForm's signUp.create() submits. Keep in sync
// with that call — if the form starts collecting a field, add it here.
const FORM_SUBMITS = new Set(['email_address', 'password']);

async function main() {
  const url = `${CLERK_FAPI_URL.replace(/\/$/, '')}/v1/environment?_clerk_js_version=5.0.0`;
  let env;
  try {
    const res = await fetch(url, { headers: { Origin: 'https://deerdawn.com' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    env = await res.json();
  } catch (err) {
    console.error(`FAIL could not read Clerk environment (${url}): ${err.message}`);
    process.exit(2);
  }

  const attrs = env?.user_settings?.attributes || {};
  const problems = [];

  for (const [name, cfg] of Object.entries(attrs)) {
    if (cfg?.required && !FORM_SUBMITS.has(name)) {
      problems.push(
        `Clerk requires "${name}" at signup, but the form does not submit it → signup returns missing_requirements. ` +
        `Set "${name}" to Optional in the Clerk Dashboard, or update MarketingAuthForm + FORM_SUBMITS to collect it.`
      );
    }
  }

  const emailVerify = attrs?.email_address?.verify_at_sign_up;
  if (emailVerify === true) {
    for (const surface of VERIFY_SURFACES) {
      // apps/marketing ships only in the private repo; in a public checkout
      // its surface is not here to check, which is not drift.
      if (!fs.existsSync(path.join(REPO_ROOT, surface))) {
        console.log(`Skipping ${surface}: not in this checkout (private repo only).`);
        continue;
      }
      const implemented = implementsVerificationStep(surface);
      if (implemented === null) {
        problems.push(`Could not read ${surface} to confirm it handles email verification.`);
      } else if (!implemented) {
        problems.push(
          `Clerk requires email verification at sign-up (verify_at_sign_up=true), but ${surface} does not ` +
          'both prepare and attempt an EmailAddressVerification → signup returns missing_requirements and ' +
          'dead-ends. Restore the verification step, or disable "verify at sign-up" for email in the Clerk Dashboard.'
        );
      }
    }
  }

  const required = Object.entries(attrs).filter(([, c]) => c?.required).map(([n]) => n);
  console.log(`Clerk instance: ${CLERK_FAPI_URL}`);
  console.log(`Required signup attributes: ${required.join(', ') || '(none)'}`);
  console.log(`Form submits: ${[...FORM_SUBMITS].join(', ')}`);
  console.log(`Email verification at sign-up: ${emailVerify === true ? 'required (surfaces must implement the step)' : 'not required'}`);

  if (problems.length) {
    console.error('\nFAIL signup config drift:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('PASS Clerk signup config matches the form contract.');
}

main();
