# DeerDawn MCP Server

Never start cold. Every new AI session opens already briefed on your project.

DeerDawn is AI session memory — your AI's chief of staff — for Claude Code, Claude.ai, Claude Desktop, ChatGPT, Cursor, Windsurf, VS Code, Zed, Codex, and any other MCP-compatible agent. Start a session anywhere and `start_session` hands the agent the brief: what you were working on, what was decided, and what's blocking — so no session starts cold.

## Quick start — hosted server (recommended, no install)

Connect to the hosted MCP endpoint. **No API key needed** — you sign in with your browser the first time a DeerDawn tool is called.

**Claude Code**

```bash
claude mcp add -s user --transport http deerdawn https://api.deerdawn.com/mcp
```

**Every other tool** — add a remote MCP server (sometimes called a connector) with this URL:

```
https://api.deerdawn.com/mcp
```

| Tool | Where |
|------|-------|
| Claude.ai | Settings → Connectors → Add custom connector |
| ChatGPT.com | Settings → Connectors → Add MCP server (choose OAuth) |
| Cursor | Settings → MCP → Add server, or add a `"url"` entry in `.cursor/mcp.json` |
| VS Code / Copilot | Command palette → MCP: Add Server → HTTP → paste the URL |
| Windsurf, Gemini, others | Add a custom remote / HTTP MCP server with the URL |

Leave any OAuth client fields blank. Click Connect (or restart the tool) and sign in when the DeerDawn tab opens. If your tool connects without prompting for sign-in, the first DeerDawn tool call returns the sign-in URL — open it, sign in once, and retry the call; setup completes automatically.

Then say: **"Start a DeerDawn session."**

The hosted server lists 7 tools: `start_session`, `recall`, `manage_memory`, `manage_tasks`, `manage_projects`, `browse_skills` and `build_subagent_brief`. The local install below uses the same grouped names and adds repo-file writes, automatic capture hooks, the local-file import and a few setup tools.

---

## Local install (stdio) — optional upgrade

Run the server on your machine via `npx -y @deerdawn/mcp-server@latest` when you want deeper integration:

- Writes `.deerdawn-context.md` / `.cursorrules` into your repo so context loads with no tool call.
- Installs a SessionStart hook that loads the project brief before the first reply, and shows you one line saying what loaded. Automatic capture (Stop and PostToolUse hooks) is optional: `setup` asks, and it stays off without a yes.
- Adds `manage_memory` `action: "import_local"`, which reads `CLAUDE.md` / `AGENTS.md` / `.cursorrules` from the repo. The hosted server has no files to read.

**Sign-in works the same way** — browser OAuth by default, no API key required. On first run without credentials, the server starts a device-flow sign-in: the URL is printed to stderr, saved to `~/.deerdawn/pending-auth.json`, and returned in-band by the `get_auth_status` tool (use that in GUI hosts where stderr isn't visible). After you approve in the browser, credentials are saved to `~/.deerdawn/credentials.json` and every future session is authenticated.

**Prefer non-interactive auth** (CI, headless, SSH)? Create a key at [app.deerdawn.com](https://app.deerdawn.com) → Settings → API Keys (it starts with `dd_`) and set `DEERDAWN_API_KEY` in the config's `env` block — browser sign-in is then skipped entirely.

### Claude Code (CLI)

Run the setup command — it registers the server, signs you in, and configures hooks in one step. In a terminal it asks three optional y/N questions: whether to turn on automatic capture (it says what is sent and where), whether to build this folder's first brief from its README, CLAUDE.md/AGENTS.md and last 20 commit subjects (it lists the files first), and, when Codex is installed and the folder has a project, whether to add DeerDawn's block to the repo's `AGENTS.md`. Run with no terminal (by an agent, in a script), every answer is no. It ends by printing your brief:

```bash
npx -y @deerdawn/mcp-server@latest setup
```

If you are not signed in yet, `setup` opens your browser to sign in when it is run in an interactive terminal on a machine with a display. Over SSH, in CI, in a script, or with no display it does not open one (set `DEERDAWN_NO_BROWSER=1` to stop it anywhere). The sign-in link is printed in every case, and opening it in any browser, on any machine, authorizes this install.

For a self-hosted DeerDawn, point `setup` at your server; it signs in there, registers that URL with Claude Code, and records it in `~/.deerdawn/config.json` (`api_url`) for the hooks:

```bash
npx -y @deerdawn/mcp-server@latest setup --api-url https://deerdawn.example.com
# or: DEERDAWN_API_URL=https://deerdawn.example.com npx -y @deerdawn/mcp-server@latest setup
```

`setup` exits non-zero if sign-in did not complete, so `npx -y @deerdawn/mcp-server@latest setup && …` stops rather than continuing against an install that cannot authenticate.

Show the active project’s task board directly in a terminal, or select a project
by its exact ID, exact name, or a unique part of its name:

```bash
npx -y @deerdawn/mcp-server@latest tasks
npx -y @deerdawn/mcp-server@latest tasks "DeerDawn"
```

Or register manually (user scope so it works across all projects):

```bash
claude mcp add -s user deerdawn -e DEERDAWN_API_URL=https://api.deerdawn.com -e DEERDAWN_SURFACE_ID=claude_code -- npx -y @deerdawn/mcp-server@latest
```

Restart Claude Code after registering. If you haven't signed in yet, call `get_auth_status` — it returns the browser URL to complete sign-in.

---

### Claude Desktop

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com"
      }
    }
  }
}
```

---

### Cursor

`~/.cursor/mcp.json` (same path on macOS, Linux, and Windows):

```json
{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com"
      }
    }
  }
}
```

---

### Windsurf

**macOS**: `~/.codeium/windsurf/mcp_config.json`
**Windows**: `%APPDATA%\Codeium\windsurf\mcp_config.json`

```json
{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com"
      }
    }
  }
}
```

---

### VS Code (GitHub Copilot / Continue)

Add to `.vscode/settings.json` or user `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "deerdawn": {
        "command": "npx",
        "args": ["-y", "@deerdawn/mcp-server@latest"],
        "env": {
          "DEERDAWN_API_URL": "https://api.deerdawn.com"
        }
      }
    }
  }
}
```

For **Continue** (`~/.continue/config.json`):

```json
{
  "mcpServers": [
    {
      "name": "deerdawn",
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com"
      }
    }
  ]
}
```

---

### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "deerdawn": {
      "command": {
        "path": "npx",
        "args": ["-y", "@deerdawn/mcp-server@latest"],
        "env": {
          "DEERDAWN_API_URL": "https://api.deerdawn.com"
        }
      }
    }
  }
}
```

---

### Codex (OpenAI)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.deerdawn]
command = "npx"
args = ["-y", "@deerdawn/mcp-server@latest"]
startup_timeout_sec = 120

[mcp_servers.deerdawn.env]
DEERDAWN_API_URL = "https://api.deerdawn.com"
```

---

To skip browser sign-in in any of these configs, add `"DEERDAWN_API_KEY": "dd_your_key_here"` to the `env` block (Codex TOML: `DEERDAWN_API_KEY = "dd_your_key_here"` under `[mcp_servers.deerdawn.env]`).

Passive capture (shell commands, changed files, and the end-of-session transcript) is opt-in: `setup` asks, and the answer is kept in `~/.deerdawn/setup-choices.json`. An install from before the question that already had the capture hooks keeps them, and is told once, at the start of a session, what they send and how to turn them off. To turn capture off regardless of that answer, set `DEERDAWN_CAPTURE=off` in the same `env` block. The capture hooks are then not installed, and ones already in `~/.claude/settings.json` are removed on the next start. Hooks run in your shell rather than in the MCP server, so also export the variable in your shell profile if you want already-installed hooks to stop immediately. `start_session` and every tool you call explicitly keep working.

---

## Host naming note

Some MCP hosts expose tools with a server prefix (for example `deerdawn-get_auth_status`) instead of bare names (`get_auth_status`).
If a tool name is not found, retry with the `deerdawn-` prefixed variant.

---

## Environment variables

All optional. With no env vars at all, the server starts and walks you through browser sign-in.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEERDAWN_API_URL` | No | `https://api.deerdawn.com` | API base URL. Only change for self-hosted or staging. |
| `DEERDAWN_SURFACE_ID` | No | auto-detected | Which tool this server runs in (`claude_code`, `cursor`, `codex`). Detected from the MCP client when unset; set it explicitly to pin session attribution. |
| `DEERDAWN_API_KEY` | No | — | API key (`dd_...`) for non-interactive auth (CI/headless). Default is browser OAuth sign-in. Get one at app.deerdawn.com → Settings → API Keys. |
| `DEERDAWN_WORKSPACE` | No | — | Work in a shared team workspace rather than the one your sign-in was minted for. Copy it from your team's `.mcp.json` (Settings → Team → Workspace config), or commit that file to the repo and set nothing. |

Your sign-in belongs to the workspace you were in when you signed in, which is why a teammate invited after installing DeerDawn still sees only their own projects. `DEERDAWN_WORKSPACE` is what redirects an existing install: it is an identifier rather than a credential, so it is safe to commit, and the API checks your membership on every request — a workspace you do not belong to is refused outright, never quietly swapped for your own.

Two sources are read, in this order: the variable in the environment, then the `env` block of the `deerdawn` entry in the nearest `.mcp.json`, searching from the project directory up to the repo root. The file matters because your editor hands that `env` block to the MCP server process and to nothing else — the SessionStart and Stop hooks are separate processes, and reading the file directly is what keeps the brief they load and the transcript they flush in the same workspace as everything else. A `.mcp.json` above the repo root is never read, and a malformed one is ignored rather than failing the hook.

`get_auth_status` and `get_setup_status` report the workspace being targeted, and `start_session` says so once per session, naming which of the two sources it came from.

---

## Session memory tools

What your agent sees in `tools/list` is deliberately small, because every listed tool is paid for in the context window of every session:

| Server | Listed tools |
|---|---|
| Hosted | 7: `start_session`, `recall`, `manage_memory`, `manage_tasks`, `manage_projects`, `browse_skills`, `build_subagent_brief` (the Claude.ai endpoint adds a read-only `read_tasks` and the add-on tools `read_addon` and `use_addon`) |
| Local, signed in | 8: the same set without `browse_skills`, plus `read_addon` and `use_addon`. `browse_skills` and `manage_skills` are listed once the workspace has synced skills, which makes 10 |
| Local, signed out | the 6 core tools plus 4 setup tools: `get_auth_status`, `get_setup_status`, `apply_setup`, `complete_setup`. The setup tools leave the list at sign-in and the add-on tools join it |

Older single-purpose names (`update_context`, `get_context`, `import_local_context`, `list_projects`, `record_hot_paths` and the rest) still dispatch, so instruction files already on disk keep working. They are not listed, and a model will usually report an unlisted tool as missing rather than guess at it. Write new instructions against the grouped names below.

### `read_addon` and `use_addon`
Add-ons are extra kinds of memory, such as a wardrobe or a reading list, switched on per workspace at `/addons` in the dashboard. Every add-on is reached through these two tools, so the list stays the same size however many there are. `read_addon` runs read actions only; `use_addon` runs any action. Start with `help`:

```json
{ "addon": "notes-example", "action": "help" }
```

### `start_session`
**Call this at the start of every session.** Returns the active project context for the current directory plus a compact map of all other projects: one API call, ~100–180 tokens total.

### `recall`
Read stored memory. `action` picks what:

| `action` | Returns |
|---|---|
| `context` | One project's brief by section. Defaults to `[task, status]` (~30 tokens); pass `sections: ["all"]` for everything |
| `projects` | Every project with its id and last-updated time |
| `search` | Matches across all projects, e.g. `"decisions about authentication"` |
| `overview` | The workspace picture. `mode: "startup"` is compact, `mode: "overview"` is the full brief |
| `map` | Durable file-level memory for a project: hot paths, entrypoints, named surfaces, debugging notes |
| `paths` | Known paths matching a query such as `"auth modal"`. Use before a repo-wide search |
| `entities` | Typed workspace knowledge: decisions, tools, environments, capabilities |
| `next` | Ranked suggestions for what to fetch next |
| `portfolio` | What is shared across projects |

```json
{ "action": "context", "project_id": "proj-abc123", "sections": ["task", "decisions", "blocking"] }
```

### `manage_memory`
Write to memory. **Call `action: "update"` whenever** a decision is made, the current task changes, a blocker is found, or meaningful progress happens. Don't wait until the end of the session: updates are cheap and keep the brief every new session reads current.

```json
{
  "action": "update",
  "project_id": "proj-abc123",
  "summary": "Switched auth from JWT to session tokens. JWT had XSS risk via localStorage. Now using Redis-backed sessions."
}
```

Pass `task` alongside `summary` when the headline of the brief should change; extraction does not change that field on its own.

| `action` | Does |
|---|---|
| `update` | Push a context update (above) |
| `import_local` | **Local server only.** Import `CLAUDE.md`, `AGENTS.md` or `.cursorrules` from the current directory. Call it without `confirmed` first for a free preview, then again with `confirmed: true` to commit |
| `record_paths` | Save discovered file or folder paths so future sessions orient without re-discovering them |
| `record_finding` | Store a concise, durable debugging finding, optionally tied to paths |
| `upsert_entities` | Create or update workspace knowledge that applies across projects |
| `confirm` / `resolve` | Confirm a stored claim, or close a stored workspace entity |
| `resolve_question` | Answer ONE open question in the brief and leave the rest alone |
| `finish_task` | Clean up task state at handoff. With `complete_task: true` it marks the active task complete and clears open-task command history |
| `export_trail` / `import_trail` | Move a project between machines as a private `.dawn` archive |

### `manage_tasks`
The project task board. `action` is one of `list`, `add`, `move`, `complete`, `remove`; phases are `backlog`, `blocked`, `in_progress`, `integration`, `testing`, `done`.

### `manage_projects`
`action` is one of `create`, `select`, `rename`, `move`, `archive`, `restore`. Use `create` when starting something that has no project entry yet.

### `browse_skills`
List the workspace's shared skill documents (`action: "list"`) or read one in full (`action: "get"` with a `slug`).

### `build_subagent_brief`
Build a small, task-scoped handoff for one AI subagent. Give DeerDawn the assignment and, optionally, a role, deliverable, success criteria, likely paths, verification steps, and a 120–600 token budget. DeerDawn selects relevant project decisions, constraints, known paths, debugging notes, and commands; redacts secrets; removes duplicates; and returns a brief with provenance.

```json
{
  "task": "Add contract tests for the billing webhook retry path",
  "role": "test engineer",
  "deliverable": "Focused tests covering retries and terminal failure",
  "acceptance_criteria": ["Tests fail before the fix", "No unrelated test changes"],
  "focus_paths": ["apps/api/tests", "apps/api/src/routes/webhooks.js"],
  "verification": ["cd apps/api && npm test"],
  "max_tokens": 250
}
```

For best results, the orchestrator should create one brief per concrete subtask, launch the worker with no inherited conversation history, and pass only the returned brief. The worker brief starts with `[DeerDawn Subagent Brief v1]`, which tells DeerDawn-aware agents that their task context is already loaded.

### Setup tools (local server, signed out only)
`get_auth_status` returns the browser sign-in URL in-band, for hosts where stderr is not visible. `complete_setup` is a one-call fallback for brittle hosts: it checks auth, applies local setup for a surface, and previews then imports local context files.

```
complete_setup
{
  "surface": "cursor"
}
```

`apply_setup` repairs one surface's config and is normally never called by hand: the server applies its own setup on the first authenticated start.

What setup writes, and what it does not:

- **Only the tool you chose.** `setup` registers Claude Code and writes Claude Code's hooks. DeerDawn's block in the global `~/.claude/CLAUDE.md` is refreshed if it is there and never added: delete it and it stays deleted (the removal is recorded). The instruction goes only into repos that have a DeerDawn project, as the `CLAUDE.md` pointer `setup` writes there. A server running inside Codex or Cursor writes that tool's file and no other's. Nothing puts your API key in `~/.claude/settings.json` or any other file its tool does not read a key from; a key an older version left there is named by `get_setup_status` and `setup`, and `npx -y @deerdawn/mcp-server@latest remove-key` deletes it when you run it (it reads a `settings.json` with comments or trailing commas, edits only the key, and blanks the key in the backup it takes). Backups are private to you (0600 in a 0700 folder) and only the newest five per tool are kept.
- **Repo files: refreshed, never added.** A boot or `start_session` updates a tool's file in your repository (`AGENTS.md`, `.cursorrules`, the Copilot file, the `CLAUDE.md` pointer, the shared skills) only if that file already carries DeerDawn's block. It never creates a tool's file. `setup` writes the files of the tool it configures.
- **Nothing unasked.** If a tool asks to be set up and no DeerDawn server is registered for it, `apply_setup` and `complete_setup` say what is missing and give the command that adds it (or, for Cursor, Codex and Claude Desktop, ask for `mode: "repair"` to have DeerDawn add the entry). They write nothing.
- **The block in your files.** DeerDawn's instruction block sits between two markers that carry a token made for this install (kept in `~/.deerdawn/install.json`). The first line says that edits inside the block are replaced. Only a block with your install's token is treated as DeerDawn's; a block from an older version, with no token, is rewritten with one the first time. Keep your own notes outside the markers. Only a pair at the start of a line in plain text counts as DeerDawn's: a pair inside an indented or fenced code block, a list, a quote or an HTML comment is your note and is left alone. An install that has no token yet (you deleted `~/.deerdawn`, or this is a second machine that shares `~/.claude/CLAUDE.md` through your dotfiles) adopts the token of the DeerDawn block already in your tool files, so it refreshes that block in place and never adds a second one. If your files hold blocks with several different tokens, nothing is adopted automatically: they are kept and named, and `get_setup_status` and `setup` say so. An install that already has a token never switches by itself: a block carrying another token is kept as it is, nothing is written beside it, and `get_setup_status` and `setup` say the file is managed by another DeerDawn install. `npx -y @deerdawn/mcp-server@latest adopt-block <tool>` makes such a block this install's own.
- **A stale block stays.** If a tool's file holds DeerDawn's block and no DeerDawn server is registered for that tool, nothing removes it. `get_setup_status` and `setup` name the file and the tool, and `npx -y @deerdawn/mcp-server@latest remove-block <claude_code|codex|cursor>` removes only that block when you run it.

---

## How it works

A fresh AI session knows nothing about your project — it would start cold. DeerDawn hands it the brief instead.

```
You work in Claude Code, Cursor, or ChatGPT
  → DeerDawn captures the session (via MCP, browser extension, or desktop app)
  → Extraction pipeline distills what changed (task, decisions, blockers, stack) into the brief
  → The brief is stored per-project in your workspace and kept current
  → Next session would start cold — instead start_session hands it the brief in one call
  → Every new session opens already briefed, never from a blank slate
```

The brief is stored per-project. Critical decisions are flagged and always surface first, regardless of token budget. If sections are trimmed, you'll see exactly what was dropped and how to retrieve it.

---

## Verify installation

After saving your config and restarting the agent, call `start_session` first:

```
start_session
```

If it returns your active project context, DeerDawn is already connected and you're done. Skip the rest. (If you connected through the hosted remote / claude.ai connector rather than the local server, this is the normal path: there is nothing to import from disk and context loads automatically.)

If `start_session` reports you're not authenticated, complete sign-in and seed context:

```
get_auth_status
start_session
manage_memory {"action":"import_local"}
manage_memory {"action":"import_local","confirmed":true}
```

Order matters: the server refuses every tool but `start_session` and the setup tools until `start_session` has run once, so calling `manage_memory` before it is answered with a refusal rather than an import. Sign in, run `start_session`, then import.

The first `manage_memory` call is a preview and writes nothing. `import_local` exists on the local server only.

If your host prefixes tool names, use `deerdawn-get_auth_status` and `deerdawn-manage_memory` instead.

If your host is flaky during setup, run `complete_setup {"surface":"claude_code"}` as a one-call fallback while still signed out. It checks auth, applies surface setup, and imports local context in a single call.

You should get back your active project context (or a prompt to import local context if it's a new workspace). If you get an error instead:

- Call `get_auth_status` and finish browser sign-in via the returned URL (if you set `DEERDAWN_API_KEY` instead, confirm it starts with `dd_`)
- Fully restart the agent (not just reload)
- Check MCP logs: `~/Library/Logs/Claude/mcp*.log` (Claude Desktop) or equivalent

---

## Troubleshooting

**DeerDawn tools don't appear in your agent**
The server itself starts with zero env vars — a missing API key never prevents startup. If no DeerDawn tools show up:
1. Fully restart your editor after saving the config (not just reload)
2. Check MCP logs:
   - Claude Desktop: `~/Library/Logs/Claude/mcp*.log`
   - Cursor: View → Output → MCP
   - Windsurf: Help → Toggle Developer Tools → Console
   - VS Code: Output panel → MCP
   - Zed: Help → Toggle Dev Tools → Console

**Authentication error / not signed in**
Call `get_auth_status` — it returns a browser sign-in URL. Open it, approve, then retry the tool call; setup completes automatically. If you set `DEERDAWN_API_KEY`, it must start with `dd_`.

**Sign-in reports a rate limit (HTTP 429)**
This happens after several quick restarts during setup. Wait a minute before retrying — re-running setup immediately will keep hitting the limit.

**`start_session` returns no projects**
On the local server, call `manage_memory` with `action: "import_local"` (without `confirmed: true` first) to seed context from a `CLAUDE.md` or `AGENTS.md` in your current directory.

**Slow responses**
The extraction pipeline runs on first import. Subsequent `start_session` calls are fast (cached context lookup, no LLM call unless something changed).

---

## Development

```bash
npm install
npm run build   # compile TypeScript
npm run dev     # watch mode
npm test        # run tests
npm run lint
```

---

## License

MIT
