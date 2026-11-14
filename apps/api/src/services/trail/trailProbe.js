'use strict';

// Probe harness: does the graph form of a Trail actually beat flat prose?
//
// This is the instrument for the "is a Trail genuinely graph-native, or are we
// artificially crippling the markdown to justify a format?" question. It runs
// the same set of realistic consumer questions against two representations of
// the SAME Trail and reports a comparable score for each:
//
//   • GRAPH strategy — a structured query over content.graph / content.* .
//   • PROSE strategy — grep over trailFlatten.js's markdown, which is the
//     honest thing a consumer would actually do with a .md file.
//
// Two things are measured, because only one of them is interesting:
//
//   1. ANSWERABILITY. Can the strategy produce the correct answer at all?
//      Expect prose to do well here. It should. A single-fact lookup in a
//      structured markdown document is not a hard problem, and pretending
//      otherwise is how you end up shipping a format nobody needs.
//
//   2. RETRIEVAL COST — bytes a strategy must load to answer. This is the
//      measure that matters for an AI-memory product, where context is the
//      scarce resource. Prose answers by loading everything that mentions the
//      term; the graph answers by loading a node and its edges.
//
// ─── Keeping this suite honest ───────────────────────────────────────────────
// A probe suite is trivially riggable — pick six traversal questions and prose
// "loses" 6-0 while proving nothing. Three rules hold it straight:
//
//   a. BALANCE. The set is weighted toward the questions prose is GOOD at.
//      Six lookup probes (where prose usually wins outright, and is often
//      cheaper than the graph) counterweight six traversal probes. Scores are
//      reported per-kind as well as blended, because the blended number hides
//      the only interesting finding — that the two forms are good at different
//      things.
//   b. BEST-EFFORT PROSE. Each prose strategy is the best a competent
//      grep-driven agent would actually do, including reading a whole section
//      when that is the right move. Where prose can answer by paying more, it
//      is scored CORRECT and charged the bytes — not marked wrong.
//   c. REALISTIC NOISE. The fixture contains notes whose bodies mention service
//      names, because real project memory does. Testing grep on a corpus with
//      no near-misses would flatter it.
//
// If prose ever wins on both axes, the honest conclusion is to ship markdown.
// tests/unit/trail-graph-native.test.js is written to fail in that case.

const { flattenToMarkdown } = require('./trailFlatten');

// ─── Prose retrieval model ───────────────────────────────────────────────────

// A grep that returns each matching line plus its indented continuation lines —
// the whole bullet, not a truncated fragment. Generous on purpose.
function grepBlocks(markdown, needle) {
  const lines = markdown.split('\n');
  const needleLower = String(needle).toLowerCase();
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].toLowerCase().includes(needleLower)) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j += 1) block.push(lines[j]);
    blocks.push(block.join('\n'));
  }
  return blocks;
}

// Read a heading's section through to the next heading of the same or higher
// level. What an agent does when the answer is "everything under X".
//
// Level matters and getting it wrong silently corrupts a probe: the flattener
// emits `## Decisions` but `### Service`, and a reader that only matched `###`
// found nothing for Decisions, fell back to scanning the whole document, and
// swept graph-node bullets in as decisions — scoring prose WRONG on a question
// it answers correctly. `###` is tried first so a node type named "Knowledge"
// resolves to its own subsection rather than the `## Knowledge` parent.
function readSection(markdown, headingText) {
  const lines = markdown.split('\n');
  const wanted = String(headingText).toLowerCase();
  let start = -1;
  let level = 3;
  for (const candidate of [3, 2]) {
    const prefix = `${'#'.repeat(candidate)} ${wanted}`;
    start = lines.findIndex((line) => line.trim().toLowerCase() === prefix);
    if (start !== -1) { level = candidate; break; }
  }
  if (start === -1) return { text: '', bytes: 0 };
  const stop = new RegExp(`^#{1,${level}} `);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (stop.test(lines[i])) break;
    out.push(lines[i]);
  }
  const text = out.join('\n');
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

// A grep consumer pays for everything it reads back — it cannot know which
// block is the right one without reading them all.
function proseCost(blocks) {
  return blocks.reduce((total, block) => total + Buffer.byteLength(block, 'utf8'), 0);
}

function jsonCost(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// Relationship lines read "- A verb phrase B". Recover (from, to) given the set
// of known titles, longest-first so "Sync Store" is not shadowed by "Sync".
function parseRelationLine(line, titles) {
  const text = line.replace(/^-\s*/, '').trim();
  if (text.startsWith('**')) return null; // a node bullet, not a relationship
  const sorted = [...titles].sort((a, b) => b.length - a.length);
  const from = sorted.find((title) => text.startsWith(title));
  const to = sorted.find((title) => text.endsWith(title) && title !== from);
  return from && to ? { from, to } : null;
}

function allTitles(content) {
  return (content.graph?.nodes || []).map((node) => node.title).filter(Boolean);
}

// Prose one-hop, shared by several traversal probes. Returns targets + bytes.
function proseHop(markdown, titles, source) {
  const blocks = grepBlocks(markdown, source);
  const targets = [];
  for (const block of blocks) {
    const parsed = parseRelationLine(block.split('\n')[0], titles);
    if (parsed && parsed.from === source) targets.push(parsed.to);
  }
  return { targets: [...new Set(targets)], bytes: proseCost(blocks) };
}

const sortedUnique = (values) => [...new Set(values.filter(Boolean))].sort();

// ─── Probes ──────────────────────────────────────────────────────────────────
// Each probe derives its own ground truth from the content, so the suite runs
// against any Trail rather than one hard-coded fixture.

const PROBES = [
  // ── lookup: prose territory ────────────────────────────────────────────────
  {
    id: 'decision_reasoning',
    kind: 'lookup',
    question: 'Why was a given decision made?',
    truth: (content) => {
      const decision = (content.decisions || []).find((entry) => entry.reasoning);
      return decision ? { key: decision.summary, answer: decision.reasoning } : null;
    },
    graph: (content, truth) => {
      const found = (content.decisions || []).find((entry) => entry.summary === truth.key);
      return { answer: found?.reasoning || null, bytes: jsonCost(found || {}) };
    },
    prose: (markdown, truth) => {
      const blocks = grepBlocks(markdown, truth.key);
      const match = blocks.find((block) => block.includes(truth.answer));
      return { answer: match ? truth.answer : null, bytes: proseCost(blocks) };
    },
  },
  {
    id: 'finding_to_files',
    kind: 'lookup',
    question: 'Which files does a given debugging finding touch?',
    truth: (content) => {
      const finding = (content.findings || []).find((entry) => entry.paths?.length);
      return finding ? { key: finding.summary, answer: [...finding.paths].sort() } : null;
    },
    graph: (content, truth) => {
      const finding = (content.findings || []).find((entry) => entry.summary === truth.key);
      return { answer: [...(finding?.paths || [])].sort(), bytes: jsonCost(finding || {}) };
    },
    prose: (markdown, truth) => {
      const blocks = grepBlocks(markdown, truth.key.slice(0, 40));
      const match = blocks.find((block) => block.includes('Files:'));
      const listed = match ? /Files:\s*(.+)/.exec(match)?.[1] : null;
      return { answer: listed ? listed.split(',').map((entry) => entry.trim()).sort() : [], bytes: proseCost(blocks) };
    },
  },
  {
    id: 'finding_fix_commit',
    kind: 'lookup',
    question: 'Which commit fixed a given finding?',
    truth: (content) => {
      const finding = (content.findings || []).find((entry) => entry.fix_commit);
      return finding ? { key: finding.summary, answer: finding.fix_commit } : null;
    },
    graph: (content, truth) => {
      const finding = (content.findings || []).find((entry) => entry.summary === truth.key);
      return { answer: finding?.fix_commit || null, bytes: jsonCost(finding || {}) };
    },
    prose: (markdown, truth) => {
      const blocks = grepBlocks(markdown, truth.key.slice(0, 40));
      const match = blocks.find((block) => block.includes('Fixed in:'));
      return { answer: match ? /Fixed in:\s*(\S+)/.exec(match)?.[1] || null : null, bytes: proseCost(blocks) };
    },
  },
  {
    id: 'command_for_label',
    kind: 'lookup',
    question: 'What is the command for a given task?',
    truth: (content) => {
      const command = (content.commands || []).find((entry) => entry.command);
      return command ? { key: command.label, answer: command.command } : null;
    },
    graph: (content, truth) => {
      const command = (content.commands || []).find((entry) => entry.label === truth.key);
      return { answer: command?.command || null, bytes: jsonCost(command || {}) };
    },
    prose: (markdown, truth) => {
      const blocks = grepBlocks(markdown, truth.key);
      const match = blocks.find((block) => block.includes(truth.answer));
      return { answer: match ? truth.answer : null, bytes: proseCost(blocks) };
    },
  },
  {
    id: 'hot_path_purpose',
    kind: 'lookup',
    question: 'Why does a given file matter?',
    truth: (content) => {
      const entry = (content.paths || []).find((path) => path.why);
      return entry ? { key: entry.path, answer: entry.why } : null;
    },
    graph: (content, truth) => {
      const entry = (content.paths || []).find((path) => path.path === truth.key);
      return { answer: entry?.why || null, bytes: jsonCost(entry || {}) };
    },
    prose: (markdown, truth) => {
      const blocks = grepBlocks(markdown, truth.key);
      const match = blocks.find((block) => block.includes(truth.answer));
      return { answer: match ? truth.answer : null, bytes: proseCost(blocks) };
    },
  },
  {
    id: 'entity_body',
    kind: 'lookup',
    question: 'What is a given entity, in one line? (with near-miss noise in the corpus)',
    truth: (content) => {
      const node = (content.graph?.nodes || []).find((entry) => entry.body && entry.node_type === 'service');
      return node ? { key: node.title, answer: node.body } : null;
    },
    graph: (content, truth) => {
      const node = (content.graph?.nodes || []).find((entry) => entry.title === truth.key);
      return { answer: node?.body || null, bytes: jsonCost(node || {}) };
    },
    prose: (markdown, truth) => {
      // Grep on a service name also returns notes that merely mention it, plus
      // its relationship lines. The right block is identifiable by its bold
      // title, so prose gets this right — it just reads the near-misses first.
      const blocks = grepBlocks(markdown, truth.key);
      const match = blocks.find((block) => block.split('\n')[0].includes(`**${truth.key}**`));
      const body = match ? match.split('\n').slice(1).map((line) => line.trim()).find((line) => line && !/^(Status|Surface):/.test(line)) : null;
      return { answer: body || null, bytes: proseCost(blocks) };
    },
  },

  // ── filter ─────────────────────────────────────────────────────────────────
  {
    id: 'entities_by_type',
    kind: 'filter',
    question: 'List every entity of a given type.',
    truth: (content) => {
      const nodes = content.graph?.nodes || [];
      const counts = new Map();
      for (const node of nodes) counts.set(node.node_type, (counts.get(node.node_type) || 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!best) return null;
      return { key: best[0], answer: sortedUnique(nodes.filter((node) => node.node_type === best[0]).map((node) => node.title)) };
    },
    graph: (content, truth) => {
      const nodes = (content.graph?.nodes || []).filter((node) => node.node_type === truth.key);
      return { answer: sortedUnique(nodes.map((node) => node.title)), bytes: jsonCost(nodes.map((n) => n.title)) };
    },
    prose: (markdown, truth) => {
      // The flattener groups nodes by type under a heading — read that section.
      const section = readSection(markdown, `${truth.key.charAt(0).toUpperCase()}${truth.key.slice(1)}`);
      const titles = [...section.text.matchAll(/^-\s+\*\*(.+?)\*\*/gm)].map((match) => match[1]);
      return { answer: sortedUnique(titles), bytes: section.bytes };
    },
  },
  {
    id: 'entities_by_status',
    kind: 'filter',
    question: 'Which entities are in a degraded state?',
    truth: (content) => {
      const nodes = (content.graph?.nodes || []).filter((node) => node.status && node.status !== 'healthy');
      return nodes.length ? { key: nodes[0].status, answer: sortedUnique(nodes.map((node) => node.title)) } : null;
    },
    graph: (content, truth) => {
      const nodes = (content.graph?.nodes || []).filter((node) => node.status === truth.key);
      return { answer: sortedUnique(nodes.map((node) => node.title)), bytes: jsonCost(nodes.map((n) => n.title)) };
    },
    prose: (markdown, truth) => {
      // Status is a continuation line, so the grep hit is the status line and
      // the title sits ABOVE it — outside the block grep returns. The agent has
      // to walk back up, which is a whole-document read in the general case.
      const lines = markdown.split('\n');
      const titles = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (!new RegExp(`^\\s+Status:\\s*${truth.key}\\s*$`).test(lines[i])) continue;
        for (let j = i - 1; j >= 0; j -= 1) {
          const match = /^-\s+\*\*(.+?)\*\*/.exec(lines[j]);
          if (match) { titles.push(match[1]); break; }
        }
      }
      return { answer: sortedUnique(titles), bytes: Buffer.byteLength(markdown, 'utf8') };
    },
  },
  {
    id: 'unresolved_decisions',
    kind: 'filter',
    question: 'Which decisions are still live?',
    truth: (content) => {
      const decisions = content.decisions || [];
      if (!decisions.length || !decisions.some((entry) => entry.resolved)) return null;
      return { key: 'unresolved', answer: sortedUnique(decisions.filter((entry) => !entry.resolved).map((entry) => entry.summary)) };
    },
    graph: (content) => {
      const live = (content.decisions || []).filter((entry) => !entry.resolved);
      return { answer: sortedUnique(live.map((entry) => entry.summary)), bytes: jsonCost(live.map((d) => d.summary)) };
    },
    prose: (markdown) => {
      // A question about the ABSENCE of a marker. There is nothing to grep for,
      // so the only correct strategy is to read every decision block and filter.
      // Prose gets the right answer and pays the whole section for it.
      const section = readSection(markdown, 'Decisions');
      const source = section.bytes ? section.text : markdown;
      const bytes = section.bytes || Buffer.byteLength(markdown, 'utf8');
      const titles = [];
      const blocks = source.split(/\n(?=-\s+\*\*)/);
      for (const block of blocks) {
        const match = /^-\s+\*\*(.+?)\*\*/.exec(block.trim());
        if (!match) continue;
        if (!/\bresolved\b/.test(block)) titles.push(match[1]);
      }
      return { answer: sortedUnique(titles), bytes };
    },
  },

  // ── negation ───────────────────────────────────────────────────────────────
  {
    id: 'isolated_nodes',
    kind: 'negation',
    question: 'Which entities are disconnected from everything else?',
    truth: (content) => {
      const nodes = content.graph?.nodes || [];
      const connected = new Set();
      for (const edge of content.graph?.edges || []) {
        connected.add(String(edge.from_node_id));
        connected.add(String(edge.to_node_id));
      }
      const orphans = nodes.filter((node) => !connected.has(String(node.node_id)));
      return orphans.length ? { key: 'isolated', answer: sortedUnique(orphans.map((node) => node.title)) } : null;
    },
    graph: (content) => {
      const connected = new Set();
      for (const edge of content.graph?.edges || []) {
        connected.add(String(edge.from_node_id));
        connected.add(String(edge.to_node_id));
      }
      const orphans = (content.graph?.nodes || []).filter((node) => !connected.has(String(node.node_id)));
      return { answer: sortedUnique(orphans.map((node) => node.title)), bytes: jsonCost(content.graph?.edges || []) };
    },
    prose: (markdown, truth, content) => {
      // Enumerate every node, enumerate every relationship, subtract. There is
      // no shortcut: the answer is defined by what is NOT written down.
      const titles = allTitles(content);
      const relationships = readSection(markdown, 'Relationships');
      const mentioned = new Set();
      for (const line of relationships.text.split('\n')) {
        const parsed = parseRelationLine(line, titles);
        if (parsed) { mentioned.add(parsed.from); mentioned.add(parsed.to); }
      }
      const orphans = titles.filter((title) => !mentioned.has(title));
      return { answer: sortedUnique(orphans), bytes: Buffer.byteLength(markdown, 'utf8') };
    },
  },

  // ── aggregate ──────────────────────────────────────────────────────────────
  {
    id: 'cards_in_phase',
    kind: 'aggregate',
    question: 'Which board cards sit in a given phase?',
    truth: (content) => {
      const cards = content.board?.cards || [];
      const counts = new Map();
      for (const card of cards) counts.set(card.phase || 'backlog', (counts.get(card.phase || 'backlog') || 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!best) return null;
      return { key: best[0], answer: sortedUnique(cards.filter((card) => (card.phase || 'backlog') === best[0]).map((card) => card.title)) };
    },
    graph: (content, truth) => {
      const cards = (content.board?.cards || []).filter((card) => (card.phase || 'backlog') === truth.key);
      return { answer: sortedUnique(cards.map((card) => card.title)), bytes: jsonCost(cards.map((c) => c.title)) };
    },
    prose: (markdown, truth) => {
      const section = readSection(markdown, truth.key);
      const titles = [...section.text.matchAll(/^-\s+(.+)$/gm)].map((match) => match[1]);
      return { answer: sortedUnique(titles), bytes: section.bytes };
    },
  },
  {
    id: 'count_by_type',
    kind: 'aggregate',
    question: 'How many entities of each type are there?',
    truth: (content) => {
      const nodes = content.graph?.nodes || [];
      if (!nodes.length) return null;
      const counts = new Map();
      for (const node of nodes) counts.set(node.node_type, (counts.get(node.node_type) || 0) + 1);
      return { key: 'counts', answer: [...counts.entries()].map(([type, n]) => `${type}=${n}`).sort() };
    },
    graph: (content) => {
      const counts = new Map();
      for (const node of content.graph?.nodes || []) counts.set(node.node_type, (counts.get(node.node_type) || 0) + 1);
      return { answer: [...counts.entries()].map(([type, n]) => `${type}=${n}`).sort(), bytes: jsonCost([...counts]) };
    },
    prose: (markdown) => {
      // Every node bullet carries its type in parentheses, so this is countable
      // — after reading the whole Knowledge section.
      const counts = new Map();
      for (const match of markdown.matchAll(/^-\s+\*\*.+?\*\*\s+\((\w+)\)$/gm)) {
        counts.set(match[1], (counts.get(match[1]) || 0) + 1);
      }
      return { answer: [...counts.entries()].map(([type, n]) => `${type}=${n}`).sort(), bytes: Buffer.byteLength(markdown, 'utf8') };
    },
  },

  // ── traverse ───────────────────────────────────────────────────────────────
  {
    id: 'one_hop_out',
    kind: 'traverse',
    question: 'What does a given entity point at?',
    truth: (content) => {
      const edges = content.graph?.edges || [];
      const nodes = new Map((content.graph?.nodes || []).map((node) => [String(node.node_id), node]));
      const counts = new Map();
      for (const edge of edges) counts.set(String(edge.from_node_id), (counts.get(String(edge.from_node_id)) || 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const source = best && nodes.get(best[0]);
      if (!source) return null;
      return {
        key: source.title,
        answer: sortedUnique(edges.filter((edge) => String(edge.from_node_id) === best[0]).map((edge) => nodes.get(String(edge.to_node_id))?.title)),
      };
    },
    graph: (content, truth) => {
      const nodes = content.graph?.nodes || [];
      const source = nodes.find((node) => node.title === truth.key);
      const byId = new Map(nodes.map((node) => [String(node.node_id), node]));
      const edges = (content.graph?.edges || []).filter((edge) => String(edge.from_node_id) === String(source?.node_id));
      return { answer: sortedUnique(edges.map((edge) => byId.get(String(edge.to_node_id))?.title)), bytes: jsonCost(edges) };
    },
    prose: (markdown, truth, content) => {
      const hop = proseHop(markdown, allTitles(content), truth.key);
      return { answer: sortedUnique(hop.targets), bytes: hop.bytes };
    },
  },
  {
    id: 'one_hop_in',
    kind: 'traverse',
    question: 'What points AT a given entity?',
    truth: (content) => {
      const edges = content.graph?.edges || [];
      const nodes = new Map((content.graph?.nodes || []).map((node) => [String(node.node_id), node]));
      const counts = new Map();
      for (const edge of edges) counts.set(String(edge.to_node_id), (counts.get(String(edge.to_node_id)) || 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const target = best && nodes.get(best[0]);
      if (!target) return null;
      return {
        key: target.title,
        answer: sortedUnique(edges.filter((edge) => String(edge.to_node_id) === best[0]).map((edge) => nodes.get(String(edge.from_node_id))?.title)),
      };
    },
    graph: (content, truth) => {
      const nodes = content.graph?.nodes || [];
      const target = nodes.find((node) => node.title === truth.key);
      const byId = new Map(nodes.map((node) => [String(node.node_id), node]));
      const edges = (content.graph?.edges || []).filter((edge) => String(edge.to_node_id) === String(target?.node_id));
      return { answer: sortedUnique(edges.map((edge) => byId.get(String(edge.from_node_id))?.title)), bytes: jsonCost(edges) };
    },
    prose: (markdown, truth, content) => {
      // Reverse edges are the asymmetry prose cannot index around: the sentence
      // "A reads from B" is filed under A. Finding everything that points at B
      // means scanning every relationship line.
      const titles = allTitles(content);
      const blocks = grepBlocks(markdown, truth.key);
      const sources = [];
      for (const block of blocks) {
        const parsed = parseRelationLine(block.split('\n')[0], titles);
        if (parsed && parsed.to === truth.key) sources.push(parsed.from);
      }
      return { answer: sortedUnique(sources), bytes: proseCost(blocks) };
    },
  },
  {
    id: 'two_hop',
    kind: 'traverse',
    question: 'What is two hops out from a given entity?',
    truth: (content) => {
      const edges = content.graph?.edges || [];
      const nodes = new Map((content.graph?.nodes || []).map((node) => [String(node.node_id), node]));
      const out = new Map();
      for (const edge of edges) {
        const key = String(edge.from_node_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(String(edge.to_node_id));
      }
      for (const [start, firstHop] of out) {
        const second = new Set();
        for (const mid of firstHop) for (const end of out.get(mid) || []) if (end !== start) second.add(end);
        if (second.size) return { key: nodes.get(start)?.title, answer: sortedUnique([...second].map((id) => nodes.get(id)?.title)) };
      }
      return null;
    },
    graph: (content, truth) => {
      const nodes = content.graph?.nodes || [];
      const byId = new Map(nodes.map((node) => [String(node.node_id), node]));
      const start = nodes.find((node) => node.title === truth.key);
      const edges = content.graph?.edges || [];
      const firstHop = edges.filter((edge) => String(edge.from_node_id) === String(start?.node_id));
      const secondHop = edges.filter((edge) => firstHop.some((first) => String(first.to_node_id) === String(edge.from_node_id)));
      return {
        answer: sortedUnique(secondHop
          .filter((edge) => String(edge.to_node_id) !== String(start?.node_id))
          .map((edge) => byId.get(String(edge.to_node_id))?.title)),
        bytes: jsonCost([...firstHop, ...secondHop]),
      };
    },
    prose: (markdown, truth, content) => {
      const titles = allTitles(content);
      const first = proseHop(markdown, titles, truth.key);
      let bytes = first.bytes;
      const reached = new Set();
      for (const mid of first.targets) {
        const next = proseHop(markdown, titles, mid);
        bytes += next.bytes;
        for (const end of next.targets) if (end !== truth.key) reached.add(end);
      }
      return { answer: sortedUnique([...reached]), bytes };
    },
  },
  {
    id: 'three_hop',
    kind: 'traverse',
    question: 'What is three hops out from a given entity?',
    truth: (content) => {
      const edges = content.graph?.edges || [];
      const nodes = new Map((content.graph?.nodes || []).map((node) => [String(node.node_id), node]));
      const out = new Map();
      for (const edge of edges) {
        const key = String(edge.from_node_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(String(edge.to_node_id));
      }
      for (const [start] of out) {
        const third = new Set();
        for (const a of out.get(start) || []) {
          for (const b of out.get(a) || []) {
            for (const c of out.get(b) || []) if (c !== start) third.add(c);
          }
        }
        if (third.size) return { key: nodes.get(start)?.title, answer: sortedUnique([...third].map((id) => nodes.get(id)?.title)) };
      }
      return null;
    },
    graph: (content, truth) => {
      const nodes = content.graph?.nodes || [];
      const byId = new Map(nodes.map((node) => [String(node.node_id), node]));
      const edges = content.graph?.edges || [];
      const start = nodes.find((node) => node.title === truth.key);
      const step = (froms) => edges.filter((edge) => froms.some((id) => String(id) === String(edge.from_node_id)));
      const first = step([start?.node_id]);
      const second = step(first.map((edge) => edge.to_node_id));
      const third = step(second.map((edge) => edge.to_node_id));
      return {
        answer: sortedUnique(third
          .filter((edge) => String(edge.to_node_id) !== String(start?.node_id))
          .map((edge) => byId.get(String(edge.to_node_id))?.title)),
        bytes: jsonCost([...first, ...second, ...third]),
      };
    },
    prose: (markdown, truth, content) => {
      const titles = allTitles(content);
      let bytes = 0;
      let frontier = [truth.key];
      for (let depth = 0; depth < 3; depth += 1) {
        const next = new Set();
        for (const node of frontier) {
          const hop = proseHop(markdown, titles, node);
          bytes += hop.bytes;
          for (const target of hop.targets) next.add(target);
        }
        frontier = [...next];
      }
      return { answer: sortedUnique(frontier.filter((title) => title !== truth.key)), bytes };
    },
  },
  {
    id: 'path_between',
    kind: 'traverse',
    question: 'Is there a path from one entity to another, and what is it?',
    truth: (content) => {
      const edges = content.graph?.edges || [];
      const nodes = new Map((content.graph?.nodes || []).map((node) => [String(node.node_id), node]));
      const out = new Map();
      for (const edge of edges) {
        const key = String(edge.from_node_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(String(edge.to_node_id));
      }
      // Longest shortest-path in the graph, so the probe exercises real distance.
      let best = null;
      for (const start of out.keys()) {
        const seen = new Map([[start, [start]]]);
        const queue = [start];
        while (queue.length) {
          const current = queue.shift();
          for (const next of out.get(current) || []) {
            if (seen.has(next)) continue;
            seen.set(next, [...seen.get(current), next]);
            queue.push(next);
          }
        }
        for (const [end, path] of seen) {
          if (end !== start && (!best || path.length > best.length)) best = path;
        }
      }
      if (!best || best.length < 3) return null;
      return {
        key: `${nodes.get(best[0])?.title} -> ${nodes.get(best[best.length - 1])?.title}`,
        from: nodes.get(best[0])?.title,
        to: nodes.get(best[best.length - 1])?.title,
        answer: best.map((id) => nodes.get(id)?.title),
      };
    },
    graph: (content, truth) => {
      const nodes = content.graph?.nodes || [];
      const byTitle = new Map(nodes.map((node) => [node.title, node]));
      const byId = new Map(nodes.map((node) => [String(node.node_id), node]));
      const out = new Map();
      for (const edge of content.graph?.edges || []) {
        const key = String(edge.from_node_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(String(edge.to_node_id));
      }
      const start = String(byTitle.get(truth.from)?.node_id);
      const goal = String(byTitle.get(truth.to)?.node_id);
      const seen = new Map([[start, [start]]]);
      const queue = [start];
      let visited = 0;
      while (queue.length) {
        const current = queue.shift();
        visited += 1;
        if (current === goal) break;
        for (const next of out.get(current) || []) {
          if (seen.has(next)) continue;
          seen.set(next, [...seen.get(current), next]);
          queue.push(next);
        }
      }
      return {
        answer: (seen.get(goal) || []).map((id) => byId.get(id)?.title),
        bytes: jsonCost((content.graph?.edges || []).slice(0, visited * 2)),
      };
    },
    prose: (markdown, truth, content) => {
      // BFS where every expansion is a fresh grep. The answer is reachable, but
      // the reader pays for the frontier at every level.
      const titles = allTitles(content);
      let bytes = 0;
      const seen = new Map([[truth.from, [truth.from]]]);
      const queue = [truth.from];
      while (queue.length) {
        const current = queue.shift();
        if (current === truth.to) break;
        const hop = proseHop(markdown, titles, current);
        bytes += hop.bytes;
        for (const next of hop.targets) {
          if (seen.has(next)) continue;
          seen.set(next, [...seen.get(current), next]);
          queue.push(next);
        }
      }
      return { answer: seen.get(truth.to) || [], bytes };
    },
  },
  {
    id: 'neighbors_of_type',
    kind: 'traverse',
    question: 'Which datastores does a given service reach, directly or indirectly?',
    truth: (content) => {
      const nodes = content.graph?.nodes || [];
      const byId = new Map(nodes.map((node) => [String(node.node_id), node]));
      const out = new Map();
      for (const edge of content.graph?.edges || []) {
        const key = String(edge.from_node_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(String(edge.to_node_id));
      }
      for (const node of nodes.filter((entry) => entry.node_type === 'service')) {
        const seen = new Set();
        const queue = [String(node.node_id)];
        while (queue.length) {
          for (const next of out.get(queue.shift()) || []) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
          }
        }
        const stores = [...seen].map((id) => byId.get(id)).filter((entry) => entry?.node_type === 'database');
        if (stores.length > 1) return { key: node.title, answer: sortedUnique(stores.map((entry) => entry.title)) };
      }
      return null;
    },
    graph: (content, truth) => {
      const nodes = content.graph?.nodes || [];
      const byId = new Map(nodes.map((node) => [String(node.node_id), node]));
      const start = nodes.find((node) => node.title === truth.key);
      const out = new Map();
      for (const edge of content.graph?.edges || []) {
        const key = String(edge.from_node_id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(String(edge.to_node_id));
      }
      const seen = new Set();
      const queue = [String(start?.node_id)];
      while (queue.length) {
        for (const next of out.get(queue.shift()) || []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      return {
        answer: sortedUnique([...seen].map((id) => byId.get(id)).filter((node) => node?.node_type === 'database').map((node) => node.title)),
        bytes: jsonCost(content.graph?.edges || []),
      };
    },
    prose: (markdown, truth, content) => {
      // Reachability AND a type filter. The type lives in the node section, the
      // reachability in the relationship section, so the reader alternates
      // between two parts of the document at every step.
      const titles = allTitles(content);
      const typeByTitle = new Map((content.graph?.nodes || []).map((node) => [node.title, node.node_type]));
      const typeSection = readSection(markdown, 'Database');
      let bytes = typeSection.bytes;
      const seen = new Set();
      const queue = [truth.key];
      while (queue.length) {
        const hop = proseHop(markdown, titles, queue.shift());
        bytes += hop.bytes;
        for (const target of hop.targets) {
          if (seen.has(target)) continue;
          seen.add(target);
          queue.push(target);
        }
      }
      return { answer: sortedUnique([...seen].filter((title) => typeByTitle.get(title) === 'database')), bytes };
    },
  },
  {
    id: 'edges_of_type',
    kind: 'filter',
    question: 'Which relationships are of a given kind?',
    truth: (content) => {
      const edges = content.graph?.edges || [];
      const nodes = new Map((content.graph?.nodes || []).map((node) => [String(node.node_id), node]));
      const counts = new Map();
      for (const edge of edges) counts.set(edge.edge_type, (counts.get(edge.edge_type) || 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!best) return null;
      return {
        key: best[0],
        answer: sortedUnique(edges
          .filter((edge) => edge.edge_type === best[0])
          .map((edge) => `${nodes.get(String(edge.from_node_id))?.title}->${nodes.get(String(edge.to_node_id))?.title}`)),
      };
    },
    graph: (content, truth) => {
      const nodes = new Map((content.graph?.nodes || []).map((node) => [String(node.node_id), node]));
      const edges = (content.graph?.edges || []).filter((edge) => edge.edge_type === truth.key);
      return {
        answer: sortedUnique(edges.map((edge) => `${nodes.get(String(edge.from_node_id))?.title}->${nodes.get(String(edge.to_node_id))?.title}`)),
        bytes: jsonCost(edges),
      };
    },
    prose: (markdown, truth, content) => {
      const titles = allTitles(content);
      const phrase = String(truth.key).replace(/_/g, ' ');
      const blocks = grepBlocks(markdown, phrase);
      const pairs = [];
      for (const block of blocks) {
        const parsed = parseRelationLine(block.split('\n')[0], titles);
        if (parsed) pairs.push(`${parsed.from}->${parsed.to}`);
      }
      return { answer: sortedUnique(pairs), bytes: proseCost(blocks) };
    },
  },
];

function sameAnswer(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [];
    const right = Array.isArray(b) ? b : [];
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return a === b;
}

/**
 * Run every probe against one Trail.
 * @param {object} trail
 * @returns {object} report
 */
function runProbes(trail) {
  const content = trail?.content || {};
  const markdown = flattenToMarkdown(trail);
  const results = [];

  for (const probe of PROBES) {
    const truth = probe.truth(content);
    if (!truth || !truth.key) {
      results.push({ id: probe.id, kind: probe.kind, skipped: 'no_ground_truth_in_trail' });
      continue;
    }
    const graph = probe.graph(content, truth);
    const prose = probe.prose(markdown, truth, content);
    results.push({
      id: probe.id,
      kind: probe.kind,
      question: probe.question,
      graph_correct: sameAnswer(graph.answer, truth.answer),
      prose_correct: sameAnswer(prose.answer, truth.answer),
      graph_bytes: graph.bytes,
      prose_bytes: prose.bytes,
    });
  }

  const scored = results.filter((result) => !result.skipped);
  const graphCorrect = scored.filter((result) => result.graph_correct).length;
  const proseCorrect = scored.filter((result) => result.prose_correct).length;
  const graphBytes = scored.reduce((total, result) => total + result.graph_bytes, 0);
  const proseBytes = scored.reduce((total, result) => total + result.prose_bytes, 0);

  // Per-kind, because the blended number hides the finding that matters: the
  // two forms are good at different questions, and which questions a consumer
  // actually asks decides whether the format earns its complexity.
  const byKind = {};
  for (const result of scored) {
    if (!byKind[result.kind]) byKind[result.kind] = { scored: 0, graph: 0, prose: 0, graph_bytes: 0, prose_bytes: 0 };
    const bucket = byKind[result.kind];
    bucket.scored += 1;
    if (result.graph_correct) bucket.graph += 1;
    if (result.prose_correct) bucket.prose += 1;
    bucket.graph_bytes += result.graph_bytes;
    bucket.prose_bytes += result.prose_bytes;
  }
  for (const bucket of Object.values(byKind)) {
    bucket.prose_parity = bucket.graph === 0 ? 1 : bucket.prose / bucket.graph;
    bucket.prose_cost_ratio = bucket.graph_bytes === 0 ? 1 : bucket.prose_bytes / bucket.graph_bytes;
  }

  return {
    probes: results,
    scored: scored.length,
    graph_answered: graphCorrect,
    prose_answered: proseCorrect,
    // The headline: how much of the graph's value does flat prose deliver?
    // 1.0 means markdown is just as good.
    prose_parity: graphCorrect === 0 ? 1 : proseCorrect / graphCorrect,
    graph_bytes: graphBytes,
    prose_bytes: proseBytes,
    // >1 means prose costs more context to answer the same questions.
    prose_cost_ratio: graphBytes === 0 ? 1 : proseBytes / graphBytes,
    markdown_bytes: Buffer.byteLength(markdown, 'utf8'),
    by_kind: byKind,
  };
}

module.exports = { runProbes, PROBES, grepBlocks, flattenToMarkdown };
