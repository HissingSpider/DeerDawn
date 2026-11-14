'use strict';

// Flatten a Trail to markdown prose — the honest strawman.
//
// This module exists to try to make Trails unnecessary. The claim underneath
// the whole Trails funnel is that a Trail is worth downloading because it is
// QUERYABLE: typed entities, real edges, fields you can filter on. If a plain
// markdown dump of the same content answers the same questions, then the
// gallery is a file-download page with extra steps, nobody needs an importer,
// and the honest move is to ship markdown and stop.
//
// So the renderer below is written in good faith and deliberately generously:
// it emits EVERY field, spells out EVERY edge as an English sentence, and
// includes the reasoning behind decisions. A rigged, lossy flattener would let
// us "prove" the graph wins while proving nothing. If this renderer looks like
// it is holding back, that is a bug — fix it, then re-run the probe harness in
// trailProbe.js and accept whatever number comes out.

function heading(level, text) {
  return `${'#'.repeat(level)} ${text}`;
}

function bullet(text) {
  return `- ${text}`;
}

function renderBrief(brief) {
  const lines = [heading(2, 'Overview')];
  if (brief.description) lines.push('', brief.description);
  const scalars = [
    ['Current task', brief.current_task],
    ['Current status', brief.current_status],
    ['Next action', brief.next_action],
    ['Blocking issue', brief.blocking_issue],
    ['Task progress', brief.task_progress],
  ].filter(([, value]) => value);
  if (scalars.length) {
    lines.push('');
    for (const [label, value] of scalars) lines.push(bullet(`**${label}:** ${value}`));
  }
  const lists = [
    ['Goals', brief.goals],
    ['Tech stack', brief.tech_stack],
    ['Open questions', brief.open_questions],
    ['Recurring context', brief.recurring_context],
    ['File structure', brief.file_structure_summary],
  ].filter(([, value]) => Array.isArray(value) && value.length);
  for (const [label, values] of lists) {
    lines.push('', heading(3, label));
    for (const value of values) lines.push(bullet(String(value)));
  }
  if (Array.isArray(brief.landmines) && brief.landmines.length) {
    lines.push('', heading(3, 'Landmines'));
    for (const entry of brief.landmines) {
      lines.push(bullet(`${entry.summary}${entry.importance ? ` _(${entry.importance})_` : ''}`));
    }
  }
  if (Array.isArray(brief.shipped) && brief.shipped.length) {
    lines.push('', heading(3, 'Shipped'));
    for (const entry of brief.shipped) lines.push(bullet(`${entry.summary}${entry.shipped_at ? ` — ${entry.shipped_at}` : ''}`));
  }
  return lines;
}

function renderDecisions(decisions) {
  if (!decisions?.length) return [];
  const lines = ['', heading(2, 'Decisions')];
  for (const decision of decisions) {
    lines.push('', bullet(`**${decision.summary}**`));
    if (decision.reasoning) lines.push(`  Why: ${decision.reasoning}`);
    const meta = [
      decision.importance ? `importance ${decision.importance}` : null,
      decision.decided_at ? `decided ${decision.decided_at}` : null,
      decision.resolved ? 'resolved' : null,
    ].filter(Boolean);
    if (meta.length) lines.push(`  (${meta.join(', ')})`);
  }
  return lines;
}

function renderGraph(graph) {
  if (!graph?.nodes?.length) return [];
  const lines = ['', heading(2, 'Knowledge')];
  const byId = new Map(graph.nodes.map((node) => [String(node.node_id), node]));

  // Group by type, so a reader can find "all the services" the way a typed
  // query would. This is the flat form doing its level best.
  const byType = new Map();
  for (const node of graph.nodes) {
    const type = node.node_type || 'knowledge';
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(node);
  }

  for (const [type, nodes] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('', heading(3, `${type.charAt(0).toUpperCase()}${type.slice(1)}`));
    for (const node of nodes) {
      lines.push('', bullet(`**${node.title}** (${type})`));
      if (node.body) lines.push(`  ${node.body}`);
      if (node.status) lines.push(`  Status: ${node.status}`);
      if (node.surface) lines.push(`  Surface: ${node.surface}`);
    }
  }

  // Every edge, spelled out as a sentence. A reader can follow one hop by
  // reading; following two means holding the first hop in their head and
  // scanning the whole list again — which is exactly the cost the probe
  // harness measures rather than assumes.
  if (graph.edges?.length) {
    lines.push('', heading(3, 'Relationships'));
    for (const edge of graph.edges) {
      const from = byId.get(String(edge.from_node_id));
      const to = byId.get(String(edge.to_node_id));
      if (!from || !to) continue;
      lines.push(bullet(`${from.title} ${String(edge.edge_type || 'relates to').replace(/_/g, ' ')} ${to.title}`));
    }
  }
  return lines;
}

function renderPaths(paths) {
  if (!paths?.length) return [];
  const lines = ['', heading(2, 'Hot paths')];
  for (const entry of paths) {
    lines.push(bullet(`\`${entry.path}\`${entry.label ? ` — ${entry.label}` : ''}${entry.why ? `. ${entry.why}` : ''}`));
  }
  return lines;
}

function renderFindings(findings) {
  if (!findings?.length) return [];
  const lines = ['', heading(2, 'Debugging findings')];
  for (const entry of findings) {
    lines.push('', bullet(entry.summary));
    if (entry.paths?.length) lines.push(`  Files: ${entry.paths.join(', ')}`);
    if (entry.fix_commit) lines.push(`  Fixed in: ${entry.fix_commit}`);
  }
  return lines;
}

function renderCommands(commands) {
  if (!commands?.length) return [];
  const lines = ['', heading(2, 'Commands')];
  for (const entry of commands) {
    lines.push(bullet(`\`${entry.command}\` — ${entry.label}${entry.why ? ` (${entry.why})` : ''}`));
  }
  return lines;
}

function renderBoard(board) {
  if (!board?.cards?.length) return [];
  const lines = ['', heading(2, 'Board')];
  const byPhase = new Map();
  for (const card of board.cards) {
    const phase = card.phase || 'backlog';
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase).push(card);
  }
  for (const [phase, cards] of byPhase) {
    lines.push('', heading(3, phase));
    for (const card of cards) lines.push(bullet(card.title));
  }
  return lines;
}

/**
 * Render a Trail as markdown prose.
 * @param {object} trail
 * @returns {string}
 */
function flattenToMarkdown(trail) {
  const manifest = trail?.manifest || {};
  const content = trail?.content || {};
  const lines = [heading(1, manifest.title || 'Trail')];
  if (manifest.source?.pinned) {
    lines.push('', `_Source: ${manifest.source.repo_url} @ ${manifest.source.commit_sha}_`);
  }
  lines.push(
    ...renderBrief(content.brief || {}),
    ...renderDecisions(content.decisions),
    ...renderGraph(content.graph),
    ...renderPaths(content.paths),
    ...renderFindings(content.findings),
    ...renderCommands(content.commands),
    ...renderBoard(content.board),
  );
  return `${lines.join('\n')}\n`;
}

module.exports = { flattenToMarkdown };
