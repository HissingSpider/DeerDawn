'use strict';

// The public MCP resource has one canonical URL. The legacy API-prefixed path
// remains mounted as a compatibility alias, but discovery and new setup copy
// must always advertise MCP_RESOURCE_PATH.
const MCP_RESOURCE_PATH = '/mcp';
const CLAUDE_MCP_RESOURCE_PATH = '/mcp/claude';
const LEGACY_MCP_RESOURCE_PATHS = ['/api/v1/mcp'];

function canonicalMcpResource(baseUrl, resourcePath = MCP_RESOURCE_PATH) {
  return `${String(baseUrl).replace(/\/+$/, '')}${resourcePath}`;
}

function normalizeMcpResource(resource, baseUrl) {
  const canonical = canonicalMcpResource(baseUrl);
  if (resource === undefined || resource === null || resource === '') return canonical;
  if (typeof resource !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(resource);
  } catch {
    return null;
  }

  const origin = new URL(baseUrl).origin;
  if (parsed.origin !== origin || parsed.search || parsed.hash) return null;
  if (parsed.pathname === CLAUDE_MCP_RESOURCE_PATH) {
    return canonicalMcpResource(baseUrl, CLAUDE_MCP_RESOURCE_PATH);
  }
  if (parsed.pathname === MCP_RESOURCE_PATH || LEGACY_MCP_RESOURCE_PATHS.includes(parsed.pathname)) {
    return canonical;
  }
  return null;
}

function isMcpRequestPath(rawUrl) {
  const path = String(rawUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
  return path === MCP_RESOURCE_PATH
    || path === CLAUDE_MCP_RESOURCE_PATH
    || LEGACY_MCP_RESOURCE_PATHS.includes(path);
}

function mcpResourceForRequest(rawUrl, baseUrl) {
  const path = String(rawUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (path === CLAUDE_MCP_RESOURCE_PATH) {
    return canonicalMcpResource(baseUrl, CLAUDE_MCP_RESOURCE_PATH);
  }
  if (path === MCP_RESOURCE_PATH || LEGACY_MCP_RESOURCE_PATHS.includes(path)) {
    return canonicalMcpResource(baseUrl);
  }
  return null;
}

module.exports = {
  MCP_RESOURCE_PATH,
  CLAUDE_MCP_RESOURCE_PATH,
  LEGACY_MCP_RESOURCE_PATHS,
  canonicalMcpResource,
  normalizeMcpResource,
  isMcpRequestPath,
  mcpResourceForRequest,
};
