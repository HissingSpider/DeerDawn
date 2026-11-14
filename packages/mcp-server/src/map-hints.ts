/**
 * The context map ends with call hints for a generic MCP client:
 * "→ Call get_context(project_id?, sections?) for details", a Sections legend,
 * and an indented "→ marks the active project" line. get_context is not in this
 * server's tools/list (the advertised read is recall(action:"context")), and a
 * model can only call what tools/list shows it, so the first thing it read
 * named a call it could not make.
 * start_session strips the same three prefixes before rendering the map; this
 * is that rule for every other place the map is shown as text.
 */
export function stripMapCallHints(map: string): string {
  return map
    .split('\n')
    .filter((line) => !line.startsWith('→ Call') && !line.startsWith('  Sections') && !line.startsWith('  →'))
    .join('\n')
    .trimEnd();
}
