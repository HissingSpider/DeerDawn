# Layer 11 — Manual MCP Setup Checklist

Complete these manually in a terminal and Claude Code before launch.

---

## Prerequisites

- API server running and publicly accessible (or tunneled via ngrok for local test)
- npm package `@deerdawn/mcp-server` published
- Claude Code installed (`claude --version`)
- `~/.deerdawn/credentials.json` does NOT exist (fresh test)

---

## First-Time MCP Setup

### Install via Claude Code

- [ ] Run: `claude mcp add deerdawn npx -- -y @deerdawn/mcp-server@latest`
- [ ] Command completes without error
- [ ] `claude mcp list` shows `deerdawn` in the list
- [ ] Claude Code sidebar shows DeerDawn tools under the MCP section

### First Session — Device Flow

- [ ] Open new Claude Code session in a project directory
- [ ] Claude automatically calls `start_session` (via CLAUDE.md hook if configured)
- [ ] Sign-in URL appears in terminal output or chat (e.g. `https://app.deerdawn.com/mcp-auth?code=...`)
- [ ] Opening URL in browser shows "Authorize DeerDawn MCP" page
- [ ] Clicking "Authorize" succeeds
- [ ] Claude Code session receives "authenticated" response
- [ ] `~/.deerdawn/credentials.json` created with file permissions 0o600
- [ ] `cat ~/.deerdawn/credentials.json` shows api_key field (do NOT share this key)

### Subsequent Session

- [ ] Open a new Claude Code session in same directory
- [ ] `start_session` returns project context immediately (no sign-in URL)
- [ ] Response includes project brief and context_map

---

## MCP Tool Tests (via Claude Code Chat)

Ask Claude to call each tool and verify responses:

- [ ] `start_session` → returns project brief + context map
- [ ] `list_projects` → returns array with project names and IDs
- [ ] `create_project` with name → returns UUID project_id
- [ ] `update_context` with summary → returns material_change confirmation
- [ ] `get_context` with project_id → returns task and status fields
- [ ] `list_context_map` → returns compact text listing
- [ ] `search_context` with query → returns results or empty array
- [ ] `import_local_context` (no confirmed) → returns preview
- [ ] `import_local_context` (confirmed=true) → creates/updates project
- [ ] `get_workspace_overview` mode=startup → returns brief
- [ ] `get_workspace_overview` mode=overview → returns full workspace
- [ ] `get_workspace_entities` → returns entity list
- [ ] `get_next_best_context` → returns ranked suggestions

---

## Stop Hook Integration

- [ ] Run: `deerdawn-mcp setup` (or confirm CLAUDE.md has Stop hook configured)
- [ ] `cat ~/.claude/settings.json` shows Stop hook pointing to `npx -y --prefer-offline @deerdawn/mcp-server@latest flush-session`
- [ ] End a Claude Code session
- [ ] Verify flush-session ran (no error in exit, context updated in dashboard)

---

## Multi-Editor MCP Config

### Cursor

- [ ] Add to `~/.cursor/mcp.json`:
  ```json
  {
    "mcpServers": {
      "deerdawn": { "command": "npx", "args": ["-y", "@deerdawn/mcp-server@latest"] }
    }
  }
  ```
- [ ] Cursor shows DeerDawn tools available
- [ ] `start_session` works in Cursor

### Claude Desktop

- [ ] Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
- [ ] Claude Desktop shows DeerDawn in integrations
- [ ] `start_session` works

---

## Error Recovery

- [ ] Temporarily set wrong API URL in env → tool returns helpful "API unreachable" message, not stack trace
- [ ] Delete `~/.deerdawn/credentials.json` → next session triggers sign-in URL again (not crash)
- [ ] Run `deerdawn-mcp flush-session` manually → completes without error

---

## Notes

| Test | Result | Issue |
|------|--------|-------|
|      |        |       |
