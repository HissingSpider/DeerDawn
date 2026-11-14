// Where this session is, sent as headers instead of in the URL.
//
// `cwd`, the hostname and the repo's workspace key used to travel as query
// parameters on every /active, /map and /workspace/next call. A query string is
// the part of a request that gets written down at every hop — the load
// balancer's access log, proxies, APM traces, error reports — so a home
// directory, a machine name and a private git remote were being copied into log
// retention on each tool call and each hook.
//
// A header cannot carry the non-ASCII characters a path can (Node refuses to send
// it), so the values are URI-encoded; the API decodes them.
//
// An API that predates this contract ignores the headers, and resolving a project
// with no cwd does not fail — it quietly picks the most recent project instead,
// which is how a brief ends up written into the wrong repo. So the API confirms
// with `X-DeerDawn-Location: header`, and a caller that sent a location and did
// not get the confirmation back repeats the request the old way.

export type SessionLocation = {
  cwd?: string | null;
  host?: string | null;
  workspaceKey?: string | null;
};

export const LOCATION_ACK_HEADER = 'x-deerdawn-location';

export function locationHeaders(location: SessionLocation): Record<string, string> {
  const headers: Record<string, string> = {};
  if (location.cwd) headers['x-deerdawn-cwd'] = encodeURIComponent(location.cwd);
  if (location.host) headers['x-deerdawn-host'] = encodeURIComponent(location.host);
  if (location.workspaceKey) headers['x-deerdawn-workspace-key'] = encodeURIComponent(location.workspaceKey);
  return headers;
}

/** The same values as the query parameters an older API reads. */
export function legacyLocationQuery(location: SessionLocation): Record<string, string> {
  const query: Record<string, string> = {};
  if (location.cwd) query.cwd = location.cwd;
  if (location.host) query.host = location.host;
  if (location.workspaceKey) query.workspace_key = location.workspaceKey;
  return query;
}

export function locationAcknowledged(ack: unknown): boolean {
  return typeof ack === 'string' && ack.toLowerCase() === 'header';
}
