const BRAND_MAP = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['chatgpt', 'ChatGPT'],
  ['claude', 'Claude'],
  ['claude ai', 'Claude'],
  ['claude desktop', 'Claude Desktop'],
  ['claude code', 'Claude Code'],
  ['claude_code', 'Claude Code'],
  ['codex', 'Codex'],
  ['cursor', 'Cursor'],
  ['deerdawn', 'DeerDawn'],
  ['electron', 'Electron'],
  ['github', 'GitHub'],
  ['gitlab', 'GitLab'],
  ['google drive', 'Google Drive'],
  ['http', 'HTTP'],
  ['https', 'HTTPS'],
  ['ide', 'IDE'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['mcp', 'MCP'],
  ['next.js', 'Next.js'],
  ['nextjs', 'Next.js'],
  ['node.js', 'Node.js'],
  ['notion api', 'Notion API'],
  ['notion', 'Notion'],
  ['obsidian', 'Obsidian'],
  ['openai', 'OpenAI'],
  ['postgres', 'Postgres'],
  ['postgresql', 'PostgreSQL'],
  ['react', 'React'],
  ['redis', 'Redis'],
  ['sdk', 'SDK'],
  ['slack', 'Slack'],
  ['sql', 'SQL'],
  ['typescript', 'TypeScript'],
  ['url', 'URL'],
  ['vscode', 'VS Code'],
  ['vs code', 'VS Code'],
]);

const SENTENCE_CASE_TYPES = new Set([
  'capability',
  'concept',
  'decision',
  'feature',
  'knowledge',
  'preference',
  'question',
  'task',
  'workflow',
]);

// Long-form content types: these hold sentences/summaries, not short labels.
// Title normalization (camelCase splitting, casing) would corrupt embedded code,
// commands, and identifiers, so they are preserved verbatim.
const CONTENT_TYPES = new Set(['decision', 'knowledge', 'question', 'note']);

// Heuristic: does this string carry code/command/identifier signals that must
// not be word-split or re-cased? Catches shell commands (flags, =, --, @scope/pkg),
// function calls, camelCase identifiers, URLs, and markdown emphasis.
function looksLikeCode(value) {
  const v = String(value || '');
  return (
    /[`(){}]/.test(v) ||           // backticks, parens, braces
    /(^|\s)--?[A-Za-z]/.test(v) || // CLI flags: -s, --flag
    /=/.test(v) ||                 // KEY=value
    /https?:\/\//.test(v) ||       // URLs
    /@[\w.-]+\//.test(v) ||        // scoped npm packages: @deerdawn/mcp-server
    /[a-z][A-Z]/.test(v) ||        // camelCase identifiers
    /\*\*/.test(v)                 // markdown bold
  );
}

function capitalizeWord(word) {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function normalizeWord(word) {
  if (!word) return '';
  const lower = word.toLowerCase();
  if (BRAND_MAP.has(lower)) return BRAND_MAP.get(lower);
  if (/^[A-Z0-9]+$/.test(word)) return word;
  return capitalizeWord(word);
}

function splitWords(title) {
  return String(title || '')
    .trim()
    .replace(/\\/g, '/')
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      if (BRAND_MAP.has(word.toLowerCase())) return [word];
      return word
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .split(' ')
        .filter(Boolean);
    });
}

function isPathLike(title, nodeType, metadata = {}) {
  const value = String(metadata.path || title || '').replace(/\\/g, '/');
  if (nodeType === 'file' || nodeType === 'component') return value.includes('/');
  return value.includes('/') && /\.[a-z0-9]+$/i.test(value);
}

function normalizeGraphNodeTitle(title, nodeType, metadata = {}) {
  const raw = String(title || '').trim();
  if (!raw) return raw;

  if (isPathLike(raw, nodeType, metadata)) {
    return String(metadata.path || raw).replace(/\\/g, '/');
  }

  // Preserve long-form content and any code/command-bearing string verbatim.
  if (CONTENT_TYPES.has(String(nodeType || '').toLowerCase()) || looksLikeCode(raw)) {
    return raw;
  }

  const exact = BRAND_MAP.get(raw.toLowerCase());
  if (exact) return exact;

  const words = splitWords(raw);
  if (!words.length) return raw;

  const normalizedWords = words.map((word) => normalizeWord(word));
  if (!SENTENCE_CASE_TYPES.has(String(nodeType || '').toLowerCase())) {
    return normalizedWords.join(' ');
  }

  return normalizedWords
    .map((word, index) => {
      if (index === 0) return word;
      const lower = word.toLowerCase();
      if (BRAND_MAP.has(lower) || word === word.toUpperCase()) return BRAND_MAP.get(lower) || word;
      return lower;
    })
    .join(' ');
}

module.exports = {
  normalizeGraphNodeTitle,
};
