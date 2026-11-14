# DeerDawn MCP Server - Quick Start Guide

## Standard setup (new users)

Use the published auto-updating MCP server:

```bash
npx -y @deerdawn/mcp-server@latest
```

### 1) Get your API key

In DeerDawn dashboard:
1. Open Settings -> API Keys
2. Create a key
3. Copy the `dd_...` key

### 2) Add MCP config (Claude Desktop example)

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://api.deerdawn.com",
        "DEERDAWN_API_KEY": "dd_prod_your_api_key_here"
      }
    }
  }
}
```

### 3) Restart your app

Quit and fully reopen Claude Desktop (or your MCP host).

### 4) Verify in chat

Ask:
- `What DeerDawn tools are available?`
- `Start a DeerDawn session`

If auth is missing, call `get_auth_status` and open the returned sign-in URL.

## Troubleshooting

### Tools not showing up
1. Restart the app fully (not just reload window).
2. Validate config JSON.
3. Check host MCP logs:
   - Claude Desktop: `~/Library/Logs/Claude/mcp*.log`
   - Cursor: Output -> MCP

### Authentication failed
1. Confirm `DEERDAWN_API_KEY` starts with `dd_`.
2. Call `get_auth_status` and complete sign-in.

### API unreachable
Confirm `DEERDAWN_API_URL` is reachable and not blocked by firewall/proxy.

## Optional: local development flow

Only use this when iterating on unpublished MCP server code.

```bash
cd packages/mcp-server
npm install
npm run build
node dist/index.js
```

For local API integration tests:

```bash
DEERDAWN_API_URL=http://localhost:8080 \
DEERDAWN_API_KEY=dev-key \
npm test
```
