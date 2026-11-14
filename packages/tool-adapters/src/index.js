const TOOL_PROFILES = {
  claude_web: {
    tool: 'claude_web',
    surface: 'browser',
    capture: 'dom-observer',
    injection: 'project-brief',
    hostnames: ['claude.ai'],
  },
  chatgpt_web: {
    tool: 'chatgpt_web',
    surface: 'browser',
    capture: 'dom-observer',
    injection: 'project-brief',
    hostnames: ['chatgpt.com'],
  },
  // gemini/perplexity are browser surfaces served by the userscript's DOM adapters
  // (apps/api/src/routes/context/userscript.js). They are in shared-context's TOOL_VALUES
  // and in the /active route's VALID_TOOLS, but were missing here — and renderInjection
  // bails with `if (!profile) return null`, so those users' briefs silently never rendered.
  gemini: {
    tool: 'gemini',
    surface: 'browser',
    capture: 'dom-observer',
    injection: 'project-brief',
    hostnames: ['gemini.google.com'],
  },
  perplexity: {
    tool: 'perplexity',
    surface: 'browser',
    capture: 'dom-observer',
    injection: 'project-brief',
    hostnames: ['perplexity.ai', 'www.perplexity.ai'],
  },
  cursor: {
    tool: 'cursor',
    surface: 'code',
    capture: 'workspace-resolution',
    injection: 'rules-file',
    hostnames: [],
    skill_sink: { kind: 'file', base: '.cursor/rules' },
  },
  claude_code: {
    tool: 'claude_code',
    surface: 'cli',
    capture: 'jsonl-tail',
    injection: 'context-file',
    hostnames: [],
    skill_sink: { kind: 'dir', base: '.claude/skills' },
  },
  codex: {
    tool: 'codex',
    surface: 'cli',
    capture: 'jsonl-tail',
    injection: 'context-file',
    hostnames: [],
    skill_sink: { kind: 'index', base: 'AGENTS.md' },
  },
};

function getToolProfile(tool) {
  return TOOL_PROFILES[tool] || null;
}

function listSupportedTools() {
  return Object.values(TOOL_PROFILES);
}

module.exports = {
  TOOL_PROFILES,
  getToolProfile,
  listSupportedTools,
};
