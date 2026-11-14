import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTools } from '../src/tools/index.js';

/**
 * Reply text is an instruction surface, and a model can only call what
 * tools/list advertises.
 *
 * Naming a dispatch-only tool in a reply hands the caller a call that comes back
 * "Unknown tool" — the same failure as the first-run setup copy that told every
 * new user to call `update_context`, which was dispatchable and unlisted, and
 * which is the best explanation this repo has for the 19 to 3 activation gap.
 * mark_resolved was still telling callers to browse with
 * `get_workspace_entities`; the advertised route is recall(action:"entities").
 *
 * The local surface narrows harder than the hosted one — everything in
 * GROUPED_LEGACY dispatches and none of it is listed — so this has more to
 * catch, not less.
 *
 * PARITY with the same contract in apps/api/tests/mcp-remote-tools-contracts.test.js.
 *
 * Source text is a weak instrument, so the rule is deliberately narrow: only
 * string literals containing whitespace count as prose, which skips the dispatch
 * target maps and every `case 'x':` label without parsing them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => fs.readFileSync(path.join(here, '..', relative), 'utf8');

/** Comment-blind: a "why" comment naming the old tool is documentation, not copy. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every name handleToolCall will dispatch, advertised or not. */
function callableToolNames(source: string): string[] {
  const start = source.indexOf('const CONTEXT_SYNC_TOOLS = [');
  const slice = source.slice(start, source.indexOf('];', start));
  return [...slice.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const indexSource = read('src/tools/index.ts');
// Both states of the surface: the skills tier is hidden until a workspace has
// skills, so a reply naming browse_skills must still be legal.
const advertised = new Set([
  ...listTools().map((tool: any) => tool.name),
  ...listTools({ authed: true, hasSkills: true }).map((tool: any) => tool.name),
  ...listTools({ authed: false, hasSkills: false }).map((tool: any) => tool.name),
]);
const unadvertised = callableToolNames(indexSource).filter((name) => !advertised.has(name));

function offendersIn(source: string, label: string): string[] {
  const body = stripComments(source);
  const literals = body.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [];
  const offenders: string[] = [];
  for (const literal of literals) {
    if (!/\s/.test(literal)) continue;
    for (const name of unadvertised) {
      if (new RegExp(`(?:^|[^a-z_])${name}(?:[^a-z_]|$)`).test(literal)) {
        offenders.push(`${label}: ${name} in ${literal.slice(0, 100)}`);
      }
    }
  }
  return offenders;
}

/**
 * Tool DESCRIPTIONS are a separate surface from reply text and are scanned
 * separately: an unadvertised tool's own description is never read by anybody,
 * so only the descriptors that reach tools/list are held to this.
 */
function advertisedDescriptions(): string[] {
  return listTools({ authed: false, hasSkills: true }).flatMap((tool: any) => [
    String(tool.description || ''),
    ...Object.values(tool.inputSchema?.properties || {}).map((prop: any) => String(prop?.description || '')),
  ]);
}

describe('replies name tools a caller can actually call', () => {
  it('has unadvertised-but-callable tools to police', () => {
    expect(unadvertised.length).toBeGreaterThan(0);
  });

  it('handler reply text never names a tool tools/list does not advertise', () => {
    const offenders = [
      ...offendersIn(handlerBody(read('src/tools/context-sync.ts'), 'handleContextSyncTool'), 'context-sync'),
      ...offendersIn(handlerBody(read('src/tools/index.ts'), 'handleToolCall'), 'index'),
    ];
    expect(offenders).toEqual([]);
  });

  it('advertised tool descriptions never name a tool tools/list does not advertise', () => {
    const offenders: string[] = [];
    for (const description of advertisedDescriptions()) {
      for (const name of unadvertised) {
        if (new RegExp(`(?:^|[^a-z_])${name}(?:[^a-z_]|$)`).test(description)) {
          offenders.push(`${name} in ${description.slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** The dispatching function's body, so tool DEFINITIONS above it are not scanned. */
function handlerBody(source: string, fnName: string): string {
  const start = source.indexOf(`export async function ${fnName}(`);
  expect(start, `${fnName} is readable`).toBeGreaterThan(-1);
  return source.slice(start);
}
