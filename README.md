# DeerDawn

**AI session memory. No session starts cold.**

DeerDawn keeps one up-to-date brief for each of your projects: what you are
working on, the decisions you have made, open questions, and the files that
matter. Every new AI session reads that brief before it starts, whether you are
in Claude Code, Claude.ai, ChatGPT, Cursor or Codex. Start a task in one tool,
pick it up in another, and the second session already knows where you left off.

- **Works where you already work.** Local tools connect through the
  `@deerdawn/mcp-server` package; Claude.ai and ChatGPT connect through one
  remote MCP URL.
- **Structured, not transcripts.** DeerDawn stores the state of the project
  (tasks, decisions, findings, known paths), not your raw conversations.
- **Built for teams too.** Share a project's brief with your team and every
  teammate's AI starts from the same picture, with per-project privacy.

## How it works

```text
A session starts in any AI tool
  -> start_session loads the project's current brief
  -> during the session, decisions, tasks and findings are saved back
  -> at the end, the conversation is distilled into structured updates
  -> the brief is updated in PostgreSQL
  -> the next session, in any tool, starts from the new brief
```

The API (`apps/api`) owns the brief and its history. The MCP server
(`packages/mcp-server`) is the bridge each AI tool talks to. The dashboard
(`apps/dashboard`) is where you read and edit briefs, manage projects and
invite your team.

## Use the hosted version

The quickest way to start is [deerdawn.com](https://deerdawn.com): sign in,
connect your AI tools, and you are done. Nothing to run.

- **Individual:** $12 per person per month, or $96 per year
- **Teams:** $15 per seat per month, or $150 per seat per year

## Self-host for free

DeerDawn is free to run on your own infrastructure, with every feature
unlocked and no license key.

```bash
git clone https://github.com/HissingSpider/DeerDawn.git && cd DeerDawn
./scripts/selfhost/init.sh     # writes .env with generated secrets; back up the key it prints
docker compose up -d           # API, dashboard, Postgres, Redis and Caddy
```

Then open <http://localhost:3000> and sign up: the first account becomes the
owner, and everyone after joins by invitation. See
[docs/self-hosting.md](docs/self-hosting.md) for requirements, choosing an LLM,
HTTPS on your own domain, upgrades and backups. Self-hosted installs send no telemetry
unless you set `TELEMETRY_ENABLED=true`.

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | The API: briefs, projects, teams, extraction, hosted MCP endpoint (Node, CommonJS) |
| `apps/dashboard` | The web app for managing briefs and teams (Next.js) |
| `apps/consumer-sim` | Load and verification simulator |
| `packages/mcp-server` | The local MCP server, published to npm as `@deerdawn/mcp-server` |
| `packages/shared-context` | Brief schemas and formatting shared by the API and the MCP server |
| `packages/tool-adapters` | How each AI tool reads the brief at session start |
| `infra/` | Docker Compose stack for local development, and the self-hosting proxy config |
| `docs/` | Documentation |

## Development

```bash
make up         # start the local stack (API, Postgres, Redis)
make migrate    # run database migrations
make seed       # seed local data
make verify     # check the context-sync flow end to end
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full setup, tests and how to
send a change.

## License

DeerDawn is open source.

- The server, dashboard and everything else not listed below are under the
  [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only). You can
  self-host, modify and use it for anything, including commercially. If you
  modify it and let others use it over a network, you must offer them the
  source of your modified version (AGPL section 13).
- The client packages you install on your own machine
  (`packages/mcp-server`, `packages/shared-context`, `packages/tool-adapters`
  and `sdks/`) are [MIT](packages/mcp-server/LICENSE).

[LICENSING.md](LICENSING.md) explains exactly what is allowed. Organisations
that cannot accept the AGPL can get a commercial license: email
support@deerdawn.com.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; you
will be asked to sign the [Contributor License Agreement](CLA.md) on your first
pull request. Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

Found a security issue? Please do not open a public issue; see
[SECURITY.md](SECURITY.md).

## Trademark

"DeerDawn" and the DeerDawn logo are trademarks of John Gilbert. The licenses
above cover the code, not the name: if you fork DeerDawn and distribute it,
give your fork a different name. See [TRADEMARK.md](TRADEMARK.md).
