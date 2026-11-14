'use strict';

const {
  buildTaskBoard,
  withheldSectionLabels,
} = require('../../../../packages/shared-context/src/index.js');

// Render a context export bundle (from contextSyncService.exportContext) as a
// human-readable markdown document. Shared by the GET /context/export download
// route and the account-deletion "email me my data" export, so both produce the
// exact same .md.
//
// ─── NOTHING IN THE BUNDLE IS DROPPED WITHOUT SAYING SO ──────────────────────
//
// This file used to print the profile, each project's task and status, its
// linked paths and its graph node titles, and nothing else. The JSON beside it
// carried the task board, the findings, the known paths, the decisions, the
// goals, the stack; the Markdown silently did not. And the Markdown is the copy
// account deletion emails as "the last copy we hold" moments before the purge,
// so what it left out was destroyed with no copy anywhere.
//
// A renderer that lists what it prints goes stale the day a section is added
// to the bundle. So this one is driven by the bundle's KEYS, at every level:
// each key is printed by a named renderer below, or listed in a NOT_RENDERED
// table with the reason it is not, or — neither — printed generically at the end
// of its block. A section added later can therefore never vanish from the
// Markdown; at worst it arrives unformatted. unaccountedKeys() names that third
// group, and tests/unit/export-completeness.test.js fails on any, so it is
// formatted (or deliberately listed) before it ships.
//
// NOT_RENDERED holds identifiers, timestamps, provenance stamps and telemetry
// the server records: nothing anybody wrote. Everything in it is still in the
// JSON export.

const NOT_RENDERED = {
  bundle: {
    owner_key: 'the workspace\'s internal id',
  },
  profile: {
    updated_at: 'a timestamp',
  },
  project: {
    project_id: 'an internal id',
  },
  context: {
    project_name: 'printed as the project heading',
    category: 'the coding/topic classification the server assigns',
    current_task_source: 'who set the task: a stamp on the task, not text',
    current_task_set_at: 'when the task was set: a stamp on the task',
    status_verified_at: 'when the status was last confirmed: a stamp',
    status_verified_commit: 'the commit the status was confirmed at: a stamp',
    blocking_issue_set_at: 'when the blocker was set: a stamp',
    last_updated: 'a timestamp; the project\'s updated date is printed under its heading',
    last_active_tool: 'which tool last touched the project: telemetry',
    last_active_host: 'which machine last touched the project: telemetry',
    tool_presence: 'which tools carry the project and when each last saw it: telemetry',
  },
  graph: {},
  skill: {
    skill_id: 'an internal id',
    owner_key: 'the workspace\'s internal id',
    slug: 'the identifier the server derives from the skill\'s name',
    visibility: 'a sharing setting',
    created_by: 'the author\'s internal user id',
    created_at: 'a timestamp',
    updated_at: 'a timestamp',
  },
  other_workspace: {
    workspace_id: 'the workspace\'s internal id; its name heads the block, or the id when it has none',
  },
  private_note: {
    node_id: 'an internal id',
  },
  closed_workspace: {
    workspace_id: 'the workspace\'s internal id; its name heads the block, or the id when it has none',
    workspace_name: 'printed in the block\'s heading',
    unreadable_projects: 'printed as a note under the block\'s projects',
  },
};

function hasContent(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function text(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value.trim() : JSON.stringify(value);
}

// A list item whose text may run over several lines: the continuation lines are
// indented so they stay inside the item instead of breaking the list.
function bullet(out, value, indent = '') {
  const [first, ...rest] = text(value).split('\n');
  out.push(`${indent}- ${first}`);
  for (const line of rest) out.push(`${indent}  ${line}`);
}

function joinParts(parts) {
  return parts.filter((part) => (typeof part === 'string' ? part.trim() : Boolean(part))).join(' — ');
}

function labelled(label, value, out) {
  out.push(`**${label}:** ${text(value)}`);
  out.push('');
}

function listed(label, items, out, itemText = text) {
  out.push(`**${label}:**`);
  for (const item of items) bullet(out, itemText(item));
  out.push('');
}

// One key, rendered from its own value. A renderer entry is [keys, render,
// options]: `keys` may name several keys one renderer covers (the board draws
// todo_items, completed_todos and task_steps as one set of columns), and it runs
// once, when any of them holds anything — or, with `always`, whenever one is
// present at all, for a heading whose zero count is itself the answer.
const field = (key, render, options) => [[key], (obj, out) => render(obj[key], out, obj), options];
const scalar = (key, label) => field(key, (value, out) => labelled(label, value, out));
const list = (key, label, itemText) => field(key, (value, out) => listed(label, Array.isArray(value) ? value : [value], out, itemText));

function renderKeyed(obj, renderers, notRendered, out) {
  const handled = new Set();
  for (const [keys, render, options] of renderers) {
    for (const key of keys) handled.add(key);
    const present = options?.always
      ? keys.some((key) => obj && Object.prototype.hasOwnProperty.call(obj, key))
      : keys.some((key) => hasContent(obj?.[key]));
    if (present) render(obj, out);
  }
  for (const key of Object.keys(obj || {})) {
    if (handled.has(key) || Object.prototype.hasOwnProperty.call(notRendered, key)) continue;
    renderUnknown(key, obj[key], out);
  }
}

// A key no renderer knows. Printed as it stands rather than dropped: an
// unformatted section is a cosmetic problem, a missing one is data loss.
function renderUnknown(key, value, out) {
  if (!hasContent(value)) return;
  if (Array.isArray(value)) {
    listed(key, value, out);
    return;
  }
  labelled(key, value, out);
}

const renderedKeys = (renderers) => renderers.flatMap(([keys]) => keys);

// ── item text ───────────────────────────────────────────────────────────────

const decisionText = (d) => (typeof d === 'object' && d
  ? joinParts([d.summary, d.reasoning && `Why: ${d.reasoning}`, d.decided_at && `(${d.decided_at})`, d.resolved && 'resolved'])
  : text(d));
const notedText = (n) => (typeof n === 'object' && n
  ? joinParts([n.summary, (n.paths || []).length && `Paths: ${n.paths.join(', ')}`, n.commit_ref && `Commit: ${n.commit_ref}`, n.added_at && `(${n.added_at})`])
  : text(n));
const shippedText = (s) => (typeof s === 'object' && s ? joinParts([s.summary, s.commit_ref && `Commit: ${s.commit_ref}`, s.shipped_at && `(${s.shipped_at})`]) : text(s));
const pathText = (p) => (typeof p === 'object' && p ? joinParts([[p.label, p.path].filter(Boolean).join(': '), p.purpose]) : text(p));
const surfaceText = (s) => (typeof s === 'object' && s ? joinParts([s.label, (s.paths || []).join(', '), s.purpose]) : text(s));
const commandText = (c) => (typeof c === 'object' && c ? joinParts([`${c.label || 'command'}: ${c.run || ''}`, c.note]) : text(c));

// The board by column, card text and body included. buildTaskBoard is the one
// definition of the board's shape (the brief, the API and the dashboard all use
// it): it folds the legacy completed_todos into Done and the current task's
// steps into their columns, so the three keys render as one board.
function renderBoard(context, out) {
  out.push('**Task board:**');
  for (const column of buildTaskBoard(context)) {
    if (!column.cards.length) continue;
    out.push(`- **${column.label}** (${column.cards.length})`);
    for (const card of column.cards) {
      const title = joinParts([card.title, card.kind === 'step' && 'step of the current task', card.assignee && `assigned to ${card.assignee}`]);
      bullet(out, title, '  ');
      if (hasContent(card.body)) {
        for (const line of text(card.body).split('\n')) out.push(`    ${line}`);
      }
    }
  }
  out.push('');
}

// ── project context ─────────────────────────────────────────────────────────

const CONTEXT_RENDERERS = [
  // A share can withhold sections from a teammate. Absent is not empty, so the
  // export says which sections exist and are not this reader's to read.
  field('withheld_sections', (_value, out, ctx) => {
    const labels = withheldSectionLabels(ctx);
    if (labels.length) { out.push(`_Not shared with you: ${labels.join(', ')}._`); out.push(''); }
  }),
  field('_decrypt_error', (_value, out) => {
    out.push('_This project\'s context could not be decrypted, so it is missing from this export._');
    out.push('');
  }),
  scalar('description', 'Description'),
  scalar('current_task', 'Current task'),
  scalar('current_status', 'Status'),
  scalar('task_progress', 'Progress'),
  scalar('next_action', 'Next action'),
  scalar('blocking_issue', 'Blocker'),
  list('goals', 'Goals'),
  list('recurring_context', 'Constraints'),
  list('tech_stack', 'Stack'),
  list('recent_decisions', 'Decisions', decisionText),
  list('open_questions', 'Open questions'),
  [['todo_items', 'completed_todos', 'task_steps'], (ctx, out) => renderBoard(ctx, out)],
  list('debugging_notes', 'Findings', notedText),
  list('landmines', 'Landmines', notedText),
  list('shipped', 'Shipped', shippedText),
  list('hot_paths', 'Known paths', pathText),
  list('entrypoints', 'Entry points', pathText),
  list('surfaces', 'Surfaces', surfaceText),
  list('file_structure_summary', 'Files'),
  list('commands', 'Commands', commandText),
  scalar('source_summary', 'Source'),
];

function renderNodes(nodes, out) {
  for (const node of nodes) {
    const summary = node.summary ? ` — ${node.summary}` : '';
    bullet(out, `${node.node_type || 'node'}: ${node.title || ''}${summary}`);
  }
}

// Most edges are derived, but a relation a caller states carries its own
// summary, so they are printed too. `titles` resolves an end to its title from
// every node in the bundle; an end that is not in it prints the summary alone.
function renderEdges(edges, out, titles) {
  out.push('**Relationships:**');
  for (const edge of edges) {
    const from = titles.get(edge.from_node_id);
    const to = titles.get(edge.to_node_id);
    const link = from && to ? `${from} ${edge.edge_type || 'related_to'} ${to}` : '';
    const summary = text(edge.summary);
    bullet(out, joinParts([link, summary === link ? '' : summary]) || edge.edge_type || 'related_to');
  }
  out.push('');
}

const graphRenderers = (titles) => [
  field('nodes', (nodes, out) => { renderNodes(nodes, out); out.push(''); }),
  field('edges', (edges, out) => renderEdges(edges, out, titles)),
  // A personal project carried from another workspace (account deletion only):
  // its links to the rest of that workspace's graph are left out, because the
  // far end is the team's (contextSyncService carriedProjectGraph). Said here,
  // in the project they were filed in.
  field('links_left_out', (count, out) => {
    const n = Number(count) || 0;
    if (n <= 0) return;
    out.push(`_${n} ${n === 1 ? 'link' : 'links'} from this project to the rest of that workspace's knowledge graph ${n === 1 ? 'is' : 'are'} not in this export._`);
    out.push('');
  }),
];

// ── a project ───────────────────────────────────────────────────────────────

// `titles`: every node title in the bundle, so an edge to another project's node
// still names it.
const projectRenderers = (titles) => [
  [['project_name', 'archived'], (p, out) => {
    out.push(`### ${p.project_name}${p.archived ? ' (archived)' : ''}`);
    out.push('');
  }],
  [['updated_at', 'archived_at'], (p, out) => {
    const dates = [p.archived_at && `Archived ${p.archived_at}`, p.updated_at && `Updated ${p.updated_at}`].filter(Boolean);
    out.push(`_${dates.join(' · ')}_`);
    out.push('');
  }],
  field('context', (context, out) => renderKeyed(context, CONTEXT_RENDERERS, NOT_RENDERED.context, out)),
  field('linked_paths', (paths, out) => labelled('Linked paths', [].concat(paths).join(', '), out)),
  field('graph', (graph, out) => {
    if (hasContent(graph?.nodes) || hasContent(graph?.edges) || Number(graph?.links_left_out) > 0) out.push('#### Knowledge graph');
    renderKeyed(graph, graphRenderers(titles), NOT_RENDERED.graph, out);
  }),
];

// ── a skill ─────────────────────────────────────────────────────────────────

// A skill body is itself Markdown. Fenced, so its headings stay inside the skill
// instead of becoming this document's; the fence is one backtick longer than any
// run in the body, so a body that contains a fence cannot close this one.
function fenced(body, out) {
  const longest = Math.max(0, ...(String(body).match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  out.push(`${fence}markdown`);
  out.push(...String(body).replace(/\s+$/, '').split('\n'));
  out.push(fence);
  out.push('');
}

function skillRenderers(projectNames) {
  return [
    [['name', 'enabled'], (s, out) => {
      out.push(`### ${s.name || s.slug || 'Untitled skill'}${s.enabled === false ? ' (switched off)' : ''}`);
      out.push('');
    }],
    field('project_id', (projectId, out) => {
      out.push(`_Project: ${projectNames.get(projectId) || projectId}_`);
      out.push('');
    }),
    field('description', (description, out) => { out.push(text(description)); out.push(''); }),
    field('markdown_content', (body, out) => fenced(body, out)),
  ];
}

// ── what was the person's alone in other workspaces ─────────────────────────
//
// Account deletion only (routes/shared/orgs.js emailContextExport). The purge
// erases, in workspaces other people belong to, what was the person's alone:
// their `personal` projects, their "you" profile there, and the graph notes
// marked private to them. So the emailed copy carries them, in blocks each
// headed with the workspace's name, so nothing in it reads as if it had lived
// in the person's own workspace, and saying what of that workspace is NOT
// here. The download never has this key: it exports the one workspace being
// looked at.

const otherWorkspaceName = (ws) => ws.workspace_name || ws.workspace_id;

// A note's OWN words: its type, title and summary, and the project it sat on
// when the person can open that project. Nothing it linked to.
const PRIVATE_NOTE_RENDERERS = [
  [['node_type', 'title', 'summary', 'project_name'], (note, out) => {
    bullet(out, joinParts([`${note.node_type || 'note'}: ${note.title || ''}`, note.summary, note.project_name && `Project: ${note.project_name}`]));
  }, { always: true }],
];

// Did somebody write anything in this profile? A stored profile carries every
// field, most of them empty, and a stamp; only a field with words in it counts.
// Exported so the deletion email asks the same question as the renderer.
function profileWritten(profile) {
  return Object.entries(profile || {}).some(([key, value]) => !Object.prototype.hasOwnProperty.call(NOT_RENDERED.profile, key) && hasContent(value));
}

function otherWorkspaceRenderers() {
  return [
    field('profile', (profile, out, ws) => {
      if (!profileWritten(profile)) return;
      const name = otherWorkspaceName(ws);
      out.push(`## Your profile in ${name}`);
      out.push('');
      out.push(`_What you told DeerDawn about yourself in ${name}, a workspace other people belong to. Only you could read it, and it is erased when your account is deleted._`);
      out.push('');
      renderKeyed(profile, PROFILE_RENDERERS, NOT_RENDERED.profile, out);
    }),
    [['workspace_name', 'projects', 'unreadable_projects'], (ws, out) => {
      const projects = Array.isArray(ws.projects) ? ws.projects : [];
      const unreadable = Number(ws.unreadable_projects) || 0;
      if (!projects.length && unreadable <= 0) return;
      const name = otherWorkspaceName(ws);
      out.push(`## Personal projects in ${name} (${projects.length})`);
      out.push('');
      out.push(`_Projects you kept personal in ${name}, a workspace other people belong to. Nobody else could read them, and they are erased when your account is deleted. That workspace's shared and private projects stay with it and are not in this export._`);
      out.push('');
      const titles = new Map(projects.flatMap((p) => p?.graph?.nodes || []).map((node) => [node.node_id, node.title]));
      const renderers = projectRenderers(titles);
      for (const project of projects) renderKeyed(project, renderers, NOT_RENDERED.project, out);
      // The purge erases by a set of ids the person's own read may not reach
      // all of. What it could not read is counted rather than dropped silently.
      if (unreadable > 0) {
        out.push(`_${unreadable} more of your personal projects in this workspace could not be read, so ${unreadable === 1 ? 'it is' : 'they are'} not in this export._`);
        out.push('');
      }
    }, { always: true }],
    field('skills', (skills, out, ws) => {
      out.push(`## Skills in your personal projects in ${otherWorkspaceName(ws)} (${skills.length})`);
      out.push('');
      const renderers = skillRenderers(new Map((ws.projects || []).map((p) => [p.project_id, p.project_name])));
      for (const skill of skills) renderKeyed(skill, renderers, NOT_RENDERED.skill, out);
    }),
    [['private_notes', 'unreadable_private_notes'], (ws, out) => {
      const notes = Array.isArray(ws.private_notes) ? ws.private_notes : [];
      const unreadable = Number(ws.unreadable_private_notes) || 0;
      if (!notes.length && unreadable <= 0) return;
      const name = otherWorkspaceName(ws);
      out.push(`## Private notes in ${name} (${notes.length})`);
      out.push('');
      out.push(`_Knowledge-graph notes marked private to you in ${name}, a workspace other people belong to. Only you could read them, and they are erased when your account is deleted. Each is here in its own words; what it was linked to in that workspace's knowledge graph is not._`);
      out.push('');
      for (const note of notes) renderKeyed(note, PRIVATE_NOTE_RENDERERS, NOT_RENDERED.private_note, out);
      if (notes.length) out.push('');
      if (unreadable > 0) {
        out.push(`_${unreadable} more of your private notes in this workspace could not be read, so ${unreadable === 1 ? 'it is' : 'they are'} not in this export._`);
        out.push('');
      }
    }, { always: true }],
  ];
}

// ── the bundle ──────────────────────────────────────────────────────────────

const PROFILE_RENDERERS = [
  field('user_profile', (value, out) => { out.push(text(value)); out.push(''); }),
  scalar('working_style', 'Working style'),
  scalar('communication_preferences', 'Communication'),
  list('expertise_areas', 'Expertise'),
  list('goals', 'Goals'),
  list('values', 'Values'),
  list('global_stack', 'Global stack'),
  list('preferences', 'Preferences'),
  list('recurring_instructions', 'Recurring instructions'),
];

// Tool switches and brief verbosity. Not writing, but a person set them, and
// printing a few lines costs less than explaining their absence.
function renderToolSettings(preferences, out) {
  out.push('## Tool settings');
  out.push('');
  for (const [key, value] of Object.entries(preferences)) {
    if (key === 'paused') {
      out.push(`- Briefs paused: ${value ? 'yes' : 'no'}`);
    } else if (key === 'tools' && value && typeof value === 'object') {
      for (const [tool, setting] of Object.entries(value)) {
        out.push(`- ${tool}: ${setting?.enabled === false ? 'off' : 'on'}${setting?.verbosity ? `, ${setting.verbosity} briefs` : ''}`);
      }
    } else {
      out.push(`- ${key}: ${text(value)}`);
    }
  }
  out.push('');
}

// What a workspace's own copy holds: the profile, tool settings, projects,
// workspace entities and skills. The person's own workspace is printed with
// these under the document title; a workspace that closed with the account is
// printed with the same ones, one heading level down, under a heading of its own.
function bundleBodyRenderers(bundle) {
  const projects = Array.isArray(bundle.projects) ? bundle.projects : [];
  const projectNames = new Map(projects.map((p) => [p.project_id, p.project_name]));
  const titles = new Map([...projects.flatMap((p) => p?.graph?.nodes || []), ...(bundle.workspace_graph?.nodes || [])]
    .map((node) => [node.node_id, node.title]));
  return [
    field('global_context', (profile, out) => {
      out.push('## Profile');
      out.push('');
      renderKeyed(profile || {}, PROFILE_RENDERERS, NOT_RENDERED.profile, out);
    }, { always: true }),
    field('preferences', (preferences, out) => renderToolSettings(preferences, out)),
    field('projects', (_value, out) => {
      out.push(`## Projects (${projects.length})`);
      out.push('');
      const renderers = projectRenderers(titles);
      for (const project of projects) renderKeyed(project, renderers, NOT_RENDERED.project, out);
    }, { always: true }),
    field('workspace_graph', (graph, out) => {
      const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
      out.push(`## Workspace entities (${nodes.length})`);
      out.push('');
      out.push('_Knowledge filed for the whole workspace rather than one project._');
      out.push('');
      renderKeyed(graph || {}, graphRenderers(titles), NOT_RENDERED.graph, out);
    }, { always: true }),
    field('skills', (skills, out) => {
      const rows = Array.isArray(skills) ? skills : [];
      out.push(`## Skills (${rows.length})`);
      out.push('');
      const renderers = skillRenderers(projectNames);
      for (const skill of rows) renderKeyed(skill, renderers, NOT_RENDERED.skill, out);
    }, { always: true }),
  ];
}

// ── a workspace that closed with the account ────────────────────────────────
//
// Account deletion only (routes/shared/orgs.js exportClosingWorkspaces). Every
// other workspace nobody but the person is in closes with the account and is
// erased whole, so the emailed copy carries all of it, each workspace in a block
// of its own headed with its name and kept apart from the person's own
// workspace and from every other closed one. The block's parts are the ones the
// person's own workspace prints, one heading level down, so no heading inside it
// can be mistaken for a section of the document itself.

const closedWorkspaceName = (ws) => ws.workspace_name || ws.workspace_id;

// One heading level down, for the lines the renderers produced as headings.
// Text inside a fenced block (a skill's body) is not a heading of ours and is
// left as it is, the way fenced() protects it from the outer document.
function demoteHeadings(lines) {
  let fence = null;
  return lines.map((line) => {
    const opening = /^(`{3,})/.exec(line);
    if (fence) {
      if (opening && opening[1].length >= fence.length && line.trim() === opening[1]) fence = null;
      return line;
    }
    if (opening) { fence = opening[1]; return line; }
    return /^#{1,5} /.test(line) ? `#${line}` : line;
  });
}

function renderClosedWorkspace(ws, out) {
  const name = closedWorkspaceName(ws);
  out.push(`## Workspace closing with your account: ${name}`);
  out.push('');
  out.push(`_You were the only person in ${name}, so it closes with your account, and everything in it is erased when the account is deleted. What follows is its own copy: its profile, projects, task boards, notes, knowledge graph and skills, kept apart from your own workspace and from every other workspace in this document._`);
  out.push('');
  const body = [];
  renderKeyed(ws, bundleBodyRenderers(ws), NOT_RENDERED.closed_workspace, body);
  out.push(...demoteHeadings(body));
  const unreadable = Number(ws.unreadable_projects) || 0;
  if (unreadable > 0) {
    out.push(`_${unreadable} more ${unreadable === 1 ? 'project' : 'projects'} in this workspace belonged to somebody who was once in it and could not be opened, so ${unreadable === 1 ? 'it is' : 'they are'} not in this export._`);
    out.push('');
  }
}

function bundleRenderers(bundle) {
  return [
    [['exported_at', 'schema_version'], (b, out) => {
      out.push('# DeerDawn context export');
      out.push('');
      out.push(`_Exported ${b.exported_at} · schema v${b.schema_version}_`);
      out.push('');
    }],
    ...bundleBodyRenderers(bundle),
    // The person's add-on data. Records are printed as JSON, because their shape
    // is each add-on's own; files are listed, never embedded.
    field('addons', (addons, out) => renderAddons(addons, out)),
    // Last, after everything of the person's own workspace, and only when there
    // is something: absent, the document is exactly what it was without it.
    field('other_workspaces', (workspaces, out) => {
      for (const ws of workspaces) renderKeyed(ws, otherWorkspaceRenderers(), NOT_RENDERED.other_workspace, out);
    }),
    field('closed_workspaces', (workspaces, out) => {
      for (const ws of workspaces) renderClosedWorkspace(ws, out);
    }),
  ];
}

function renderAddons(addons, out) {
  const records = Array.isArray(addons?.records) ? addons.records : [];
  const files = Array.isArray(addons?.attachments) ? addons.attachments : [];
  const enabled = Array.isArray(addons?.enabled) ? addons.enabled : [];
  if (!records.length && !files.length && !enabled.length) return;
  out.push(`## Add-ons (${records.length} records, ${files.length} files)`);
  out.push('');
  if (enabled.length) {
    out.push(`_Switched on in this workspace: ${enabled.join(', ')}._`);
    out.push('');
  }
  const groups = new Map();
  for (const record of records) {
    const key = `${record.addon_id} / ${record.collection}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: record.id, created_at: record.created_at, updated_at: record.updated_at, data: record.data });
  }
  for (const [key, rows] of groups) {
    out.push(`### ${key} (${rows.length})`);
    out.push('');
    const body = JSON.stringify(rows, null, 2);
    const longest = Math.max(0, ...(body.match(/`+/g) || []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    out.push(`${fence}json`, ...body.split('\n'), fence, '');
  }
  if (files.length) {
    out.push('### Files');
    out.push('');
    out.push('_Listed, not embedded. Download each one at its path while signed in._');
    out.push('');
    for (const file of files) {
      out.push(`- ${file.addon_id} / ${file.collection}: ${file.id} (${file.mime}, ${file.bytes} bytes${file.record_id ? `, record ${file.record_id}` : ''}) ${file.download || ''}`.trim());
    }
    out.push('');
  }
}

function renderContextExportMarkdown(bundle) {
  const out = [];
  renderKeyed(bundle, bundleRenderers(bundle), NOT_RENDERED.bundle, out);
  return out.join('\n');
}

// Every key in `bundle` that no renderer prints and NOT_RENDERED does not list,
// as a path ("projects[].context.foo"). Those still reach the Markdown, through
// renderUnknown, but unformatted: the test that calls this keeps the list empty.
function unaccountedKeys(bundle) {
  const found = new Set();
  const check = (obj, renderers, notRendered, path) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const known = new Set([...renderedKeys(renderers), ...Object.keys(notRendered)]);
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) found.add(path ? `${path}.${key}` : key);
    }
  };
  // The body of a workspace's copy, at `prefix` ('' for the person's own
  // workspace, 'closed_workspaces[].' for one that closed with the account).
  const checkBody = (body, prefix) => {
    check(body?.global_context, PROFILE_RENDERERS, NOT_RENDERED.profile, `${prefix}global_context`);
    check(body?.workspace_graph, graphRenderers(new Map()), NOT_RENDERED.graph, `${prefix}workspace_graph`);
    for (const project of body?.projects || []) {
      check(project, projectRenderers(new Map()), NOT_RENDERED.project, `${prefix}projects[]`);
      check(project?.context, CONTEXT_RENDERERS, NOT_RENDERED.context, `${prefix}projects[].context`);
      check(project?.graph, graphRenderers(new Map()), NOT_RENDERED.graph, `${prefix}projects[].graph`);
    }
    for (const skill of body?.skills || []) {
      check(skill, skillRenderers(new Map()), NOT_RENDERED.skill, `${prefix}skills[]`);
    }
  };
  check(bundle, bundleRenderers(bundle || {}), NOT_RENDERED.bundle, '');
  checkBody(bundle, '');
  for (const ws of bundle?.closed_workspaces || []) {
    check(ws, bundleBodyRenderers(ws), NOT_RENDERED.closed_workspace, 'closed_workspaces[]');
    checkBody(ws, 'closed_workspaces[].');
  }
  for (const ws of bundle?.other_workspaces || []) {
    check(ws, otherWorkspaceRenderers(), NOT_RENDERED.other_workspace, 'other_workspaces[]');
    check(ws?.profile, PROFILE_RENDERERS, NOT_RENDERED.profile, 'other_workspaces[].profile');
    for (const note of ws?.private_notes || []) {
      check(note, PRIVATE_NOTE_RENDERERS, NOT_RENDERED.private_note, 'other_workspaces[].private_notes[]');
    }
    for (const project of ws?.projects || []) {
      check(project, projectRenderers(new Map()), NOT_RENDERED.project, 'other_workspaces[].projects[]');
      check(project?.context, CONTEXT_RENDERERS, NOT_RENDERED.context, 'other_workspaces[].projects[].context');
      check(project?.graph, graphRenderers(new Map()), NOT_RENDERED.graph, 'other_workspaces[].projects[].graph');
    }
    for (const skill of ws?.skills || []) {
      check(skill, skillRenderers(new Map()), NOT_RENDERED.skill, 'other_workspaces[].skills[]');
    }
  }
  return [...found];
}

module.exports = { renderContextExportMarkdown, unaccountedKeys, profileWritten };
