'use strict';

// A2A Agent Card — https://a2a-protocol.org/latest/specification/ §8.
//
// The card is published at the apex host (deerdawn.com/.well-known/agent-card.json,
// built by apps/marketing/src/lib/agentDiscovery.ts) because that is the domain an
// A2A client resolves. This module is the API-side copy: it backs the same
// well-known path on api.deerdawn.com and the JSON-RPC `GetAgentCard` method.
//
// The two copies are pinned byte-for-byte by the parity test in
// packages/shared-context/tests/contracts.test.js — change one, change both.

const A2A_BASE_PATH = '/a2a/v1';
const A2A_PROTOCOL_VERSION = '1.0';
const selfHostedUrls = require('./selfHosted');

const A2A_AGENT_VERSION = '1.0.0';
const A2A_SCOPES = ['context:read', 'context:write'];

// Hosted: the env var or the deerdawn.com default, as before. Self-hosted:
// PUBLIC_URL stands in for any of them that is unset (config/selfHosted.js).
function apiUrl() {
  return selfHostedUrls.apiBaseUrl() || selfHostedUrls.dashboardBaseUrl();
}

function siteUrl() {
  return selfHostedUrls.marketingBaseUrl();
}

function appUrl() {
  return selfHostedUrls.dashboardBaseUrl();
}

// Each skill maps to a capability DeerDawn already performs deterministically
// over stored context — see SKILL_HANDLERS in src/routes/a2a.js.
const A2A_SKILLS = [
  {
    id: 'load-project-brief',
    name: 'Load project brief',
    description:
      'Return the current DeerDawn brief for a project — active task, recent decisions, tech stack, open questions, and where the last session left off — so a calling agent starts warm instead of cold.',
    tags: ['memory', 'context', 'briefing', 'session'],
    examples: [
      'Load the brief for my DeerDawn project.',
      'What is the current state of the checkout-rewrite project?',
    ],
  },
  {
    id: 'search-memory',
    name: 'Search project memory',
    description:
      'Search stored project memory across every workspace project and return the matching tasks, decisions, goals, and open questions with the project they belong to.',
    tags: ['memory', 'search', 'retrieval'],
    examples: [
      'What did we decide about the pricing page?',
      'Search memory for anything about the auth migration.',
    ],
  },
  {
    id: 'read-task-board',
    name: 'Read task board',
    description:
      'Return the project task board — cards grouped across Backlog, Blocked, In Progress, Integration, Testing, and Done — as structured data.',
    tags: ['tasks', 'planning', 'status'],
    examples: [
      'What is in progress on the DeerDawn board?',
      'Show me the task board.',
    ],
  },
  {
    id: 'record-memory-update',
    name: 'Record memory update',
    description:
      'Write a summary of what changed — a decision made, a task moved, a feature shipped — back into the project brief so the next session inherits it. Requires the context:write scope.',
    tags: ['memory', 'write', 'handoff'],
    examples: [
      'Record that we chose Postgres over DynamoDB for the event store.',
      'Save this session summary to the project brief.',
    ],
  },
];

function buildAgentCard() {
  const site = siteUrl();
  return {
    name: 'DeerDawn',
    description:
      'AI session memory. DeerDawn stores a project brief — current task, recent decisions, tech stack, open questions, and where you left off — and hands it to every new AI session across Claude, ChatGPT, Codex, Cursor, and Claude Code, so no session starts cold.',
    // Ordered by preference; the first entry is the preferred interface.
    supportedInterfaces: [
      {
        url: `${apiUrl()}${A2A_BASE_PATH}`,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: 'DeerDawn',
      url: site,
    },
    version: A2A_AGENT_VERSION,
    documentationUrl: `${site}/connect`,
    iconUrl: `${site}/brand-mark.png`,
    capabilities: {
      // DeerDawn answers a memory request in one round trip: no long-running
      // tasks, so no SSE stream and no push-notification callbacks.
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    securitySchemes: {
      oauth2: {
        oauth2SecurityScheme: {
          description:
            'OAuth 2.1 authorization code + PKCE. Public clients only; register dynamically (RFC 7591) or via a Client ID Metadata Document.',
          oauth2MetadataUrl: `${apiUrl()}/.well-known/oauth-authorization-server`,
          flows: {
            authorizationCode: {
              authorizationUrl: `${apiUrl()}/api/v1/oauth/authorize`,
              tokenUrl: `${apiUrl()}/api/v1/oauth/token`,
              scopes: {
                'context:read': 'Read project briefs, memory, and task boards.',
                'context:write': 'Write updates back into project briefs and task boards.',
              },
              pkceRequired: true,
            },
          },
        },
      },
      apiKey: {
        httpAuthSecurityScheme: {
          description: `Send "Authorization: Bearer <dd_… API key>" using a key from ${appUrl()}/api-keys.`,
          scheme: 'Bearer',
          bearerFormat: 'DeerDawn API key',
        },
      },
    },
    // Either scheme alone is sufficient (the list is an OR of requirements).
    securityRequirements: [
      { schemes: { oauth2: { list: A2A_SCOPES } } },
      { schemes: { apiKey: { list: [] } } },
    ],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: A2A_SKILLS,
  };
}

module.exports = {
  A2A_BASE_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_AGENT_VERSION,
  A2A_SCOPES,
  A2A_SKILLS,
  buildAgentCard,
};
