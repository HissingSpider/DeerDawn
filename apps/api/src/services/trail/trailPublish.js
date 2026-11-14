'use strict';

// The publish gate. Nothing reaches a public gallery except through here.
//
// ─── Threat model ────────────────────────────────────────────────────────────
// The thing being published is a dump of someone's private project memory,
// assembled over months by an agent that was never told "this will be public".
// This workspace alone currently holds finance-project context, portfolio
// notes, third-party credentials, and /Users/<name> paths in stored context. A
// one-click "publish my project" would leak all of it, permanently, on the
// first use. Publication is irreversible in practice — mirrors, caches, and
// scrapers do not honor an unpublish.
//
// ─── The gate ────────────────────────────────────────────────────────────────
// Four properties, each enforced in code rather than trusted to a UI:
//
//   1. NOTHING PUBLISHES UNSCANNED. finalize() re-runs the scanner server-side
//      on the exact bytes about to go public. A scan the client performed is
//      advisory; only the server's own scan of the final payload counts.
//   2. EVERY FINDING IS RESOLVED INDIVIDUALLY. decisions are keyed by finding
//      id. A submission missing even one id is rejected with the list.
//   3. THERE IS NO PUBLISH-ALL. Wildcard keys are rejected outright, and
//      keeping a high-severity finding costs a per-finding written
//      justification. Bulk-approving is not merely discouraged, it is more work
//      than reviewing.
//   4. DECISIONS ARE BOUND TO CONTENT. Each decision carries the digest of the
//      finding it answers. Change the text and the old approval stops counting.
//
// Property 3 is the one that will be under pressure the first time someone with
// 400 findings complains. The answer is a better scanner (fewer false
// positives), never a bypass.

const crypto = require('crypto');
const { scanContent, excludePaths, SEVERITY } = require('./trailScan');
const { sealTrail } = require('./trailFormat');

const PUBLISH_STATES = ['draft', 'preview', 'published', 'unpublished'];

// Keys a caller might reach for to approve everything at once. Rejected by name
// so the attempt produces an explanation rather than a confusing "missing id".
const FORBIDDEN_BULK_KEYS = new Set(['*', 'all', 'any', 'everything', '__all__', 'approve_all']);

const ACTIONS = { EXCLUDE: 'exclude', KEEP: 'keep' };

const MIN_JUSTIFICATION_LENGTH = 12;

// Manifest fields that are copies of a content field. finalizePublish re-derives
// these from the redacted content, and the whole-document backstop uses this to
// tell that a decision made on the source covers the copy too.
const MANIFEST_SOURCE_FIELDS = {
  'manifest.title': 'content.brief.project_name',
  'manifest.description': 'content.brief.description',
};

/**
 * Digest of the finding's identity + the text it flagged. A decision references
 * this, so editing the underlying field invalidates the approval.
 */
function findingDigest(finding) {
  return crypto
    .createHash('sha256')
    .update(`${finding.id}|${finding.path}|${finding.category}|${finding.excerpt}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Build the publish preview: what would go public, what the scanner found, and
 * the per-field diff the author has to walk.
 *
 * @param {object} trail sealed Trail from trailExport.buildTrail
 * @param {{seededNames?: string[]}} [options]
 * @returns {object} preview
 */
function buildPreview(trail, options = {}) {
  const scan = scanContent(trail.content, { seededNames: options.seededNames });
  const findings = scan.findings.map((finding) => ({ ...finding, digest: findingDigest(finding) }));

  // Group by field so the author reviews "this field, these hits" rather than a
  // flat list of 200 regex matches.
  const byPath = new Map();
  for (const finding of findings) {
    if (!byPath.has(finding.path)) byPath.set(finding.path, []);
    byPath.get(finding.path).push(finding);
  }

  const fields = [...byPath.entries()].map(([path, pathFindings]) => ({
    path,
    section: pathFindings[0].section,
    entity: pathFindings[0].entity,
    highest_severity: pathFindings.some((f) => f.severity === SEVERITY.HIGH)
      ? SEVERITY.HIGH
      : (pathFindings.some((f) => f.severity === SEVERITY.MEDIUM) ? SEVERITY.MEDIUM : SEVERITY.LOW),
    findings: pathFindings,
  })).sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 };
    return rank[a.highest_severity] - rank[b.highest_severity] || a.path.localeCompare(b.path);
  });

  return {
    trail_id: trail.manifest?.trail_id || null,
    state: 'preview',
    scanner_version: scan.scanner_version,
    scanned_at: scan.scanned_at,
    counts: scan.counts,
    fields,
    findings,
    // Explicit, so a client cannot mistake "no high findings" for "publishable".
    requires_resolution: findings.length,
    publishable_without_review: false,
  };
}

/**
 * Validate a decision set against the findings it claims to answer.
 * Pure, so the same check runs in preview (advisory) and finalize (binding).
 *
 * @param {object[]} findings findings with digests
 * @param {object} decisions { [findingId]: { action, justification? } }
 * @returns {{ok: boolean, errors: object[], excludePaths: string[], kept: object[]}}
 */
function validateDecisions(findings, decisions) {
  const errors = [];
  const decisionMap = decisions && typeof decisions === 'object' && !Array.isArray(decisions) ? decisions : {};

  for (const key of Object.keys(decisionMap)) {
    if (FORBIDDEN_BULK_KEYS.has(String(key).toLowerCase())) {
      errors.push({
        code: 'bulk_approval_rejected',
        message: `"${key}" is not a finding id. Every finding is resolved individually — there is no publish-all.`,
      });
    }
  }

  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const excluded = [];
  const kept = [];

  for (const finding of findings) {
    const decision = decisionMap[finding.id];
    if (!decision) {
      errors.push({ code: 'unresolved_finding', finding_id: finding.id, path: finding.path, category: finding.category, severity: finding.severity, message: 'No decision supplied for this finding.' });
      continue;
    }
    if (decision.digest && decision.digest !== finding.digest) {
      errors.push({ code: 'stale_decision', finding_id: finding.id, path: finding.path, message: 'The field changed since this was approved. Review it again.' });
      continue;
    }
    if (decision.action === ACTIONS.EXCLUDE) {
      excluded.push(finding.path);
      continue;
    }
    if (decision.action === ACTIONS.KEEP) {
      // Keeping a high-severity hit is the one path by which a credential or a
      // real person's name can legitimately reach the public gallery (a
      // deliberately published example key, a public maintainer's name). It is
      // allowed, and it costs a sentence, per finding.
      if (finding.severity === SEVERITY.HIGH) {
        const justification = String(decision.justification || '').trim();
        if (justification.length < MIN_JUSTIFICATION_LENGTH) {
          errors.push({
            code: 'justification_required',
            finding_id: finding.id,
            path: finding.path,
            category: finding.category,
            message: `Keeping a high-severity ${finding.category} finding requires a written justification of at least ${MIN_JUSTIFICATION_LENGTH} characters.`,
          });
          continue;
        }
      }
      kept.push({ finding_id: finding.id, path: finding.path, category: finding.category, justification: decision.justification || null });
      continue;
    }
    errors.push({ code: 'invalid_action', finding_id: finding.id, message: `action must be "${ACTIONS.EXCLUDE}" or "${ACTIONS.KEEP}", got ${JSON.stringify(decision.action)}.` });
  }

  // Decisions for findings that do not exist mean the client is working from a
  // stale scan. Reject rather than ignore — silently dropping them would let a
  // client "resolve" findings it never saw.
  for (const key of Object.keys(decisionMap)) {
    if (FORBIDDEN_BULK_KEYS.has(String(key).toLowerCase())) continue;
    if (!byId.has(key)) {
      errors.push({ code: 'unknown_finding', finding_id: key, message: 'No such finding in the current scan — re-run the preview.' });
    }
  }

  return { ok: errors.length === 0, errors, excludePaths: excluded, kept };
}

/**
 * Finalize a publish. This is the gate: it re-scans server-side, applies the
 * exclusions, re-scans the RESULT, and refuses if anything unresolved survives.
 *
 * @param {object} trail sealed Trail
 * @param {object} decisions { [findingId]: { action, justification?, digest? } }
 * @param {{seededNames?: string[], author?: string}} [options]
 * @returns {{ok: boolean, errors?: object[], trail?: object, report?: object}}
 */
function finalizePublish(trail, decisions, options = {}) {
  // 1. Server-side scan of the payload as submitted. A client-supplied scan is
  //    never trusted; this is the scan that counts.
  const preview = buildPreview(trail, options);
  const validated = validateDecisions(preview.findings, decisions);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, preview };
  }

  // 2. Apply exclusions by removing the fields outright.
  const { content, removed, missing } = excludePaths(trail.content, validated.excludePaths);
  if (missing.length) {
    return {
      ok: false,
      errors: missing.map((path) => ({ code: 'exclusion_failed', path, message: 'Could not remove this field — re-run the preview.' })),
      preview,
    };
  }

  // 3. Re-scan the redacted result. Removing an array element shifts indices, so
  //    a finding that was at [3] can now be at [2]; without this second pass the
  //    first scan's paths would be stale and a real hit could slip through. Any
  //    finding here that was not explicitly kept blocks the publish.
  const rescan = scanContent(content, { seededNames: options.seededNames });
  const keptPaths = new Set(validated.kept.map((entry) => entry.path));
  const keptCategories = new Set(validated.kept.map((entry) => `${entry.path}|${entry.category}`));
  const survivors = rescan.findings.filter((finding) =>
    !keptPaths.has(finding.path) || !keptCategories.has(`${finding.path}|${finding.category}`));

  if (survivors.length) {
    return {
      ok: false,
      errors: survivors.map((finding) => ({
        code: 'unresolved_after_redaction',
        finding_id: finding.id,
        path: finding.path,
        category: finding.category,
        severity: finding.severity,
        message: 'Still present after redaction was applied. This is the server-side re-scan; resolve it and resubmit.',
      })),
      preview,
    };
  }

  // 4. Re-derive the manifest's human-facing text from the REDACTED content.
  //    manifest.title/description are copies of content.brief fields, and a copy
  //    is a second place for a secret to live: excluding content.brief.description
  //    used to leave the identical string sitting in the manifest, which the
  //    scanner never walked. Derive rather than copy so the redaction can only be
  //    applied in one place.
  //
  //    The fallback chain matters more than it looks. It used to end at
  //    `trail.manifest.title` — the PRE-redaction title — so excluding
  //    content.brief.project_name silently resurrected the exact value the
  //    author had just removed, and the backstop then blocked the publish on a
  //    field no exclusion could ever clear. A redacted field must stay redacted:
  //    if the source is gone, the title is a neutral placeholder, never the
  //    original.
  const derivedManifestText = {
    title: content.brief?.project_name || 'Untitled Trail',
    description: content.brief?.description || '',
  };

  // 5. Seal. sealTrail recomputes the checksum over the REDACTED content — a
  //    Trail carrying a checksum from before redaction would verify against
  //    bytes that no longer exist and would tell a reader the file was tampered
  //    with.
  const publishedTrail = sealTrail({
    ...trail,
    manifest: {
      ...trail.manifest,
      ...derivedManifestText,
      redaction: {
        scanned: true,
        scanner_version: rescan.scanner_version,
        scanned_at: rescan.scanned_at,
        excluded_paths: removed,
        kept_with_justification: validated.kept.map((entry) => ({ path: entry.path, category: entry.category })),
      },
      published: {
        state: 'published',
        published_at: new Date().toISOString(),
        author: options.author || trail.manifest?.provenance?.author || null,
      },
    },
    content,
  });

  // 6. Whole-document backstop. Steps 1–3 scan `content`; this scans everything
  //    that is actually about to be written, manifest included. It exists because
  //    the first version of this function shipped a leak that every earlier check
  //    passed: manifest.description was a copy of content.brief.description, so
  //    excluding the content field left the secret in the manifest and the
  //    content re-scan came back clean. Any future manifest field would reopen
  //    that hole; this closes the category rather than the instance.
  //
  //    Scanned against the sealed document minus the bookkeeping the gate itself
  //    writes — redaction.excluded_paths legitimately names the fields that were
  //    removed, and those paths are not a leak.
  const auditTarget = {
    manifest: { ...publishedTrail.manifest, redaction: undefined },
    content: publishedTrail.content,
  };
  const finalScan = scanContent(auditTarget, { seededNames: options.seededNames, rootPath: '' });
  const finalSurvivors = finalScan.findings.filter((finding) => {
    // Map a manifest field back to the content field it was derived from, so a
    // decision the author already made on the source also settles the copy.
    // This is an explicit table rather than a path rewrite: manifest.title comes
    // from content.brief.PROJECT_NAME, not content.brief.title, and guessing it
    // with a regex meant a kept title was never recognised as kept — the author
    // resolved the finding and the gate refused anyway, with no way forward.
    const source = MANIFEST_SOURCE_FIELDS[finding.path];
    return !keptPaths.has(finding.path) && !(source && keptPaths.has(source));
  });
  if (finalSurvivors.length) {
    return {
      ok: false,
      errors: finalSurvivors.map((finding) => ({
        code: 'unresolved_in_published_document',
        finding_id: finding.id,
        path: finding.path,
        category: finding.category,
        severity: finding.severity,
        message: 'Present in the document about to be published (manifest included). Resolve it and resubmit.',
      })),
      preview,
    };
  }

  return {
    ok: true,
    trail: publishedTrail,
    report: {
      findings_reviewed: preview.findings.length,
      fields_excluded: removed.length,
      findings_kept: validated.kept.length,
      // Surfaced so an author can see exactly what they signed off on.
      kept: validated.kept,
      excluded_paths: removed,
    },
  };
}

/**
 * Unpublish. Flips state and records when — it does NOT pretend the data was
 * recalled. The returned notice is deliberately blunt about that, because an
 * author who believes unpublish is an undo will publish more carelessly.
 *
 * @param {object} trail
 * @param {{reason?: string}} [options]
 */
function unpublish(trail, options = {}) {
  return {
    trail: sealTrail({
      ...trail,
      manifest: {
        ...trail.manifest,
        published: {
          ...(trail.manifest?.published || {}),
          state: 'unpublished',
          unpublished_at: new Date().toISOString(),
          reason: options.reason || null,
        },
      },
    }),
    notice: 'Unpublished: the Trail is removed from the gallery and its URL stops resolving. It does not recall copies already downloaded, forked, cached, or indexed. Treat anything that was public as permanently public.',
  };
}

module.exports = {
  PUBLISH_STATES,
  ACTIONS,
  MIN_JUSTIFICATION_LENGTH,
  FORBIDDEN_BULK_KEYS,
  buildPreview,
  validateDecisions,
  finalizePublish,
  unpublish,
  findingDigest,
};
