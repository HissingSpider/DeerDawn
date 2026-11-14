import type { DeerdawnClient } from '../client.js';
import { buildMcpInstructions } from '../instruction-block.js';
import { detectSurfaceState } from '../surface-state.js';
import { stripMapCallHints } from '../map-hints.js';

export async function contextSyncAssistantPrompt(
  client: DeerdawnClient,
  // Whether this session is signed in, which decides whether the setup tools
  // are in tools/list at all (SETUP_TIER is hidden once authed). Read from the
  // same local state tools/list reads, unless a caller already knows.
  { authed = detectSurfaceState().authed }: { authed?: boolean } = {},
): Promise<string> {
  let mapText = '';
  try {
    const result = await client.getContextMap();
    if (result?.map) {
      const map = stripMapCallHints(String(result.map));
      if (map.trim()) mapText = `\n\nContext index:\n${map}`;
    }
  } catch {
    try {
      const result = await client.listContextProjects();
      const projects = result?.projects ?? [];
      if (projects.length > 0) {
        mapText = '\n\nProjects:\n' + projects
          .map((p: any) => `- ${p.project_name} (${p.project_id})`)
          .join('\n');
      }
    } catch { /* non-fatal */ }
  }

  // Core directives come from the single canonical source (buildMcpInstructions),
  // the same string injected via the MCP `initialize` response — so an explicitly
  // invoked prompt can never drift from the always-on instructions. Below it we
  // add the richer, advanced retrieval guidance that only matters when a user
  // deliberately loads this prompt, plus the live context map.
  return `${buildMcpInstructions()}

## Advanced retrieval (when you need more than the basics)
- **Ambiguous active project** → \`recall(action:"overview", mode:"startup")\` or \`mode:"overview"\`.
- **A specific project** → \`recall(action:"context", project_id, sections=["task","decisions","questions"])\`. Request only relevant sections; never \`sections=["all"]\` proactively because it is expensive.
- **Unsure what to fetch next** → \`recall(action:"next")\` before a broad retrieval.
- **Preferences or style** → \`recall(action:"context", sections=["description"])\` on the "You" global context, or use the profile in the map.
${authed ? '' : SETUP_LINE}- **Tracking tasks** → use \`manage_tasks\`. Add cards with \`action:"add"\`, move them with \`action:"move"\` and a phase, and read the board with \`action:"list"\`.
- **Task complete** → call \`manage_memory(action:"finish_task", complete_task:true, confirm_complete:true)\` after reviewing the task state and confirming there are no unresolved questions.

## Rules
- If your host tool registry prefixes names (for example \`deerdawn-start_session\`), use the prefixed variants consistently.
- Treat missing \`start_session\` as a blocker: call it before any repo search or implementation work.
- Use DeerDawn before repo search for orientation and known paths; use repo search only when you need file-level or symbol-level resolution DeerDawn does not yet know.
- Never narrate the context back ("I see you're working on X...") — just use it.
- A "Since last session" catch-up is the ONE exception: voice it in at most two sentences (top change anchored in time, then the open thread as an offer), then stop. Empty catch-up → one readiness line. Never invent progress that isn't in the payload.
- On first connect to a project directory that has CLAUDE.md or AGENTS.md but no DeerDawn context yet, use \`manage_memory(action:"import_local")\`.${mapText}`;
}

// Only while signed out: get_setup_status / apply_setup are the SETUP_TIER of
// tools/list and are hidden once the session is authed, which is every session
// that can build this prompt with a live map. Naming them there handed the
// model two calls that come back "Unknown tool".
const SETUP_LINE = '- **Inspect or repair setup** → `get_setup_status`; only `apply_setup` when the user wants DeerDawn configured on this machine.\n';
