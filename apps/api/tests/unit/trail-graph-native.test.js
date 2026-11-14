/**
 * Is a Trail genuinely graph-native, or would a markdown file do? No DB.
 *
 * This suite exists to be able to FAIL in a way that kills the feature. The
 * product bet is that a Trail is worth an importer, a format, and a gallery
 * because it is queryable. If flat markdown — rendered in good faith by
 * trailFlatten.js — delivers most of that value, the honest conclusion is to
 * ship markdown, and these assertions are how we would find that out rather
 * than assume our way past it.
 *
 * Read the numbers, do not tune them.
 */
const test = require('node:test');
const assert = require('node:assert');

const { runProbes } = require('../../src/services/trail/trailProbe');
const { flattenToMarkdown } = require('../../src/services/trail/trailFlatten');
const { buildTrail } = require('../../src/services/trail/trailExport');
const { makeProject } = require('../helpers/trailFixture');

function trailAtScale(scale) {
  const project = makeProject({ scale });
  return buildTrail({ project, graph: project.graph, trailId: `trail_scale_${scale}`, exportedAt: '2026-08-17T00:00:00.000Z' });
}

test('the flattener is good faith: no section is silently dropped', () => {
  // If this fails, the graph-vs-prose comparison below is rigged and its result
  // means nothing. Every content section must appear in the markdown.
  const trail = trailAtScale(2);
  const markdown = flattenToMarkdown(trail);

  assert.match(markdown, /Harden the extraction retry path/, 'brief missing');
  assert.match(markdown, /Store context as JSONB/, 'decisions missing');
  assert.match(markdown, /The shape changes every few weeks/, 'decision reasoning missing');
  assert.match(markdown, /Context API/, 'graph nodes missing');
  assert.match(markdown, /Relationships/, 'graph edges missing');
  assert.match(markdown, /contextSyncService\.js/, 'hot paths missing');
  assert.match(markdown, /zod instances/, 'findings missing');
  assert.match(markdown, /npm test/, 'commands missing');
  assert.match(markdown, /Instrument retry latency/, 'board missing');
});

test('every probe has ground truth in the fixture', () => {
  // A probe that skips is a probe that proves nothing; a suite that quietly
  // skips half its probes would report a flattering parity score.
  const report = runProbes(trailAtScale(2));
  const skipped = report.probes.filter((probe) => probe.skipped);
  assert.deepStrictEqual(skipped.map((p) => p.id), [], 'some probes had no ground truth to test against');
});

test('the graph form answers every probe', () => {
  const report = runProbes(trailAtScale(2));
  const missed = report.probes.filter((probe) => !probe.skipped && !probe.graph_correct);
  assert.deepStrictEqual(missed.map((p) => p.id), [], 'the queryable form failed its own probes');
});

test('MEASURED: flat prose answers everything the graph does', () => {
  // Recorded rather than asserted-against, because it is the finding.
  //
  // An earlier, narrower version of this suite reported prose at 83% and we
  // nearly shipped that claim. It was wrong: two of the six prose strategies
  // were under-powered (the two-hop reader could not parse a relationship line
  // it should have handled), and a section reader matched only `###` so it
  // silently fell back to scanning the whole document. Widening the set to 19
  // probes and fixing those strategies took prose from 83% to 100%.
  //
  // The lesson is worth more than the number: a probe suite scores the
  // IMPLEMENTATION of a strategy, not the strategy's ceiling. A weak grep
  // reader looks like proof that grep cannot do something.
  const report = runProbes(trailAtScale(3));
  assert.strictEqual(
    report.prose_answered,
    report.graph_answered,
    `Prose answerability changed (${report.prose_answered}/${report.graph_answered}). If prose got WORSE, check for a harness bug before concluding the graph won.`,
  );
});

test('VERDICT: the graph earns its complexity on retrieval cost, or not at all', () => {
  // The product constraint was "if a markdown export delivers ~80% of the value
  // the whole funnel leaks". On answerability markdown delivers 100% — so the
  // entire case for the format rests on what it COSTS to answer. That is a real
  // argument for an AI-memory product, where context is the budget, but it is
  // the ONLY argument and this test exists to keep us from forgetting that.
  //
  // If this ever fails, the honest response is to ship markdown.
  const report = runProbes(trailAtScale(3));

  const detail = Object.entries(report.by_kind)
    .map(([kind, bucket]) => `  ${kind}: prose ${bucket.prose}/${bucket.scored} correct, ${bucket.prose_cost_ratio.toFixed(2)}x cost`)
    .join('\n');
  const summary = [
    `answerability: prose ${report.prose_answered}/${report.graph_answered} (${(report.prose_parity * 100).toFixed(0)}%)`,
    `retrieval cost: ${report.prose_cost_ratio.toFixed(2)}x (graph ${report.graph_bytes}B, prose ${report.prose_bytes}B)`,
    detail,
  ].join('\n');

  assert.ok(
    report.prose_cost_ratio >= 3,
    `Prose answers everything AND costs about the same — the Trail format is not earning its complexity. Ship markdown.\n${summary}`,
  );
});

test('the cost advantage is concentrated in filter, aggregate, and negation', () => {
  // Where the graph actually wins, so the claim can be made precisely instead
  // of as a vague "structure is better". Lookup is a near-tie and should be
  // described that way in any copy about Trails.
  const report = runProbes(trailAtScale(3));

  assert.ok(
    report.by_kind.lookup.prose_cost_ratio < 1.5,
    `Lookup is supposed to be a near-tie; got ${report.by_kind.lookup.prose_cost_ratio.toFixed(2)}x. If lookup now favours the graph strongly, the prose strategy probably regressed.`,
  );
  for (const kind of ['filter', 'aggregate', 'negation']) {
    assert.ok(
      report.by_kind[kind].prose_cost_ratio > 3,
      `${kind} should be materially cheaper in the graph; got ${report.by_kind[kind].prose_cost_ratio.toFixed(2)}x`,
    );
  }
});

test('multi-hop traversal is answerable in prose, but costs more per hop', () => {
  // Prose CAN traverse — a grep per hop, following names. It is not a wall, it
  // is a toll, and the toll compounds with depth. Saying "markdown can't
  // traverse" would be false and an OSS audience would disprove it in a minute.
  const report = runProbes(trailAtScale(3));
  const hops = ['one_hop_out', 'two_hop', 'three_hop'].map((id) => report.probes.find((probe) => probe.id === id));
  for (const hop of hops) {
    assert.ok(hop && !hop.skipped, `${hop?.id} did not run`);
    assert.strictEqual(hop.graph_correct, true, `the graph form should answer ${hop.id} exactly`);
  }
  const ratios = hops.map((hop) => hop.prose_bytes / hop.graph_bytes);
  assert.ok(
    ratios[2] > ratios[0],
    `the per-hop toll should compound with depth (1-hop ${ratios[0].toFixed(2)}x, 3-hop ${ratios[2].toFixed(2)}x)`,
  );
});

test('the prose penalty grows with Trail size', () => {
  // A Trail that has accumulated months of context is the case that matters. If
  // the gap does not widen with size, the format only helps on toy examples.
  const small = runProbes(trailAtScale(1));
  const large = runProbes(trailAtScale(3));
  assert.ok(
    large.prose_cost_ratio >= small.prose_cost_ratio,
    `retrieval cost gap narrowed as the Trail grew (small ${small.prose_cost_ratio.toFixed(2)}x, large ${large.prose_cost_ratio.toFixed(2)}x)`,
  );
});
