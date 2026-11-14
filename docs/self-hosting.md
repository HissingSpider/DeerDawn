# Self-hosting DeerDawn

DeerDawn runs as five containers on one machine: the API, the dashboard,
Postgres, Redis, and Caddy (a reverse proxy that puts the dashboard and the API
on one address and, if you give it a domain, gets HTTPS certificates for it).
One command starts all of them.

- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [How the pieces fit](#how-the-pieces-fit)
- [Sign-up and invitations](#sign-up-and-invitations)
- [Connecting MCP clients](#connecting-mcp-clients)
- [Choosing an LLM](#choosing-an-llm)
- [Plain HTTP and localhost](#plain-http-and-localhost)
- [HTTPS with your own domain](#https-with-your-own-domain)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Configuration reference](#configuration-reference)
- [License and your modifications](#license-and-your-modifications)
- [Telemetry](#telemetry)
- [Troubleshooting](#troubleshooting)

## Requirements

- Docker Engine 24+ with the Compose plugin v2.24 or newer (`docker compose version`).
  Docker Desktop on macOS and Windows works.
- `openssl` and `bash` (to generate secrets on first run).
- 2 GB of RAM and a few GB of disk. linux/amd64 and linux/arm64 are both supported.
- An LLM endpoint for extraction: an OpenAI or OpenRouter API key, or a local
  [Ollama](https://ollama.com). See [Choosing an LLM](#choosing-an-llm).
- Only for HTTPS: a domain name pointing at the machine, with ports 80 and 443 open.

## Quickstart

```bash
git clone https://github.com/HissingSpider/DeerDawn.git
cd DeerDawn
./scripts/selfhost/init.sh     # writes .env with generated secrets, asks which LLM to use
docker compose up -d           # pulls the images (or builds them if it cannot), runs migrations
```

`init.sh` prints your `ENCRYPTION_MASTER_KEY`. **Back it up now**, somewhere other
than this machine (a password manager is fine). Everything DeerDawn stores is
encrypted with it; if it is lost, the data cannot be read, and no backup brings
it back. See [Backups](#backups).

Then:

1. Open <http://localhost:3000> (or the URL `init.sh` printed).
2. Click **Sign up** and create your account. With the default
   `SIGNUP_MODE=invite_only`, the **first** account to sign up becomes the owner,
   and everyone after that joins by invitation from **Settings > Team**.
3. Go to **Setup** to connect your AI tools (next section).

`docker compose ps` should show every service as `healthy` (the caddy service
has no health check and shows `running`). The API is ready when
`curl http://localhost:3000/healthz` answers `ok`.

To build the images from your checkout instead of pulling them (for example
before any release has been published, or to run local changes):

```bash
docker compose build
docker compose up -d
```

Stop with `docker compose down`. Your data lives in Docker volumes and survives
that. `docker compose down -v` **deletes all of it**.

## How the pieces fit

```
                     DEERDAWN_PUBLIC_URL (e.g. http://localhost:3000)
                                       |
                                    caddy
             /api/v1/*, /mcp, /.well-known/*,          everything else
             /healthz, /health/*, /a2a/*, /docs  ------------------------+
                         |                                               |
                        api :8080  <-- server-side calls (internal) -- dashboard :3000
                       /     \
                 postgres    redis
```

**One origin.** The dashboard and the API are served from the same address. The
dashboard's browser code calls the API on its own origin, and MCP clients use
`<DEERDAWN_PUBLIC_URL>/mcp`.

**How the dashboard learns its URL at runtime.** Next.js bakes `NEXT_PUBLIC_*`
values into the JavaScript at build time, so one prebuilt image cannot normally
serve different URLs. The dashboard image is therefore built with a placeholder
URL. When the container starts, its entrypoint replaces the placeholder with
`DEERDAWN_PUBLIC_URL` in the built files. The few requests the dashboard's own
server makes to the API (OAuth consent and the device sign-in) go straight to
the API container at `http://api:8080`, because the public URL may not be
reachable from inside a container. If you change `DEERDAWN_PUBLIC_URL`, run
`docker compose up -d`; Compose recreates the dashboard container with the new
URL.

**Migrations.** On every start the API applies the base schema (every statement
is `CREATE ... IF NOT EXISTS`) and then its incremental migrations. Both do
nothing when the database is already up to date. There is no separate migrate
step.

## Sign-up and invitations

`SIGNUP_MODE` in `.env` decides who may create an account:

- `invite_only` (the default): the **first** account created on the install
  becomes its owner. After that, a sign-up is accepted only with a live
  invitation for that email address; anyone else gets `signup_invite_required`.
  Two people signing up at the same moment on an empty install cannot both
  become owners: the first account is claimed under a database lock.
- `open`: anyone who can reach the URL can sign up. Sign-up does not verify
  email addresses, so only use this on a network you trust.

Invite teammates from **Settings > Team** in the dashboard. Without an email
provider configured (`RESEND_API_KEY`, see the configuration reference), no
email is sent: the API writes the invitation link to its log instead, and you
pass it on yourself. Find it with:

```bash
docker compose logs api | grep "Share this link"
```

The line reads `[TEAM] Invitation for <email> ... Share this link with them: <url>`.
The link is a capability to join your workspace, so send it to that person
only.

## Connecting MCP clients

Replace `https://deerdawn.example.com` below with your `DEERDAWN_PUBLIC_URL`
(for a local install that is `http://localhost:3000`).

### Claude Code

One command (signs you in through your DeerDawn in the browser, registers the
server with Claude Code, and installs the session hooks):

```bash
npx -y @deerdawn/mcp-server@latest setup --api-url https://deerdawn.example.com
```

`--api-url` (or `DEERDAWN_API_URL` in the environment) is what points it at your
install; without it, setup connects to the hosted service. The dashboard's
**Setup** page shows this command with your address already filled in.

Remote (streamable HTTP, you sign in through your DeerDawn in the browser):

```bash
claude mcp add --transport http -s user deerdawn https://deerdawn.example.com/mcp
```

Then run `/mcp` inside Claude Code and choose **Authenticate**.

Local (stdio, the `@deerdawn/mcp-server` npm package): create an API key in the
dashboard under **Setup > API keys**, then:

```bash
claude mcp add -s user deerdawn \
  -e DEERDAWN_API_URL=https://deerdawn.example.com \
  -e DEERDAWN_API_KEY=dd_your_key \
  -- npx -y @deerdawn/mcp-server@latest
```

`DEERDAWN_API_URL` is the variable that points the npm package at your server.
Without it, it talks to the hosted service at `api.deerdawn.com`.

### Cursor

In `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "deerdawn": { "url": "https://deerdawn.example.com/mcp" }
  }
}
```

Or the stdio package, with an API key from **Setup > API keys**:

```json
{
  "mcpServers": {
    "deerdawn": {
      "command": "npx",
      "args": ["-y", "@deerdawn/mcp-server@latest"],
      "env": {
        "DEERDAWN_API_URL": "https://deerdawn.example.com",
        "DEERDAWN_API_KEY": "dd_your_key"
      }
    }
  }
}
```

### Codex

```bash
codex mcp add deerdawn --url https://deerdawn.example.com/mcp && codex mcp login deerdawn
```

### ChatGPT

ChatGPT connects from OpenAI's servers, so your DeerDawn must be reachable from
the internet over HTTPS (see [HTTPS with your own domain](#https-with-your-own-domain)).
In ChatGPT, open **Settings > Apps & Connectors**, turn on developer mode under
**Advanced**, choose **Create**, and enter `https://deerdawn.example.com/mcp` as
the MCP server URL with OAuth authentication. ChatGPT sends you to your
DeerDawn's sign-in and consent page.

### Other clients

Any MCP client that supports streamable HTTP and OAuth can use
`https://deerdawn.example.com/mcp`. The OAuth metadata is published at
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource`.

## Choosing an LLM

DeerDawn uses an LLM to extract decisions, tasks and findings from your
sessions, and an embeddings model for search. Any OpenAI-compatible endpoint
works. Set these in `.env`, then run `docker compose up -d`:

| Variable | Default | Meaning |
|---|---|---|
| `LLM_API_URL` | `https://api.openai.com/v1` | Base URL of the endpoint. |
| `LLM_API_KEY` | | Its API key. Falls back to `OPENAI_API_KEY`. May be empty for a local server. |
| `LLM_MODEL` | `gpt-4o-mini` | Chat model, as the endpoint spells it. |
| `LLM_EMBEDDING_MODEL` | `text-embedding-3-small` | Embeddings model. On a non-OpenAI URL, embeddings are used only when you set this. |
| `LLM_TIMEOUT_MS` | per call | Per-request timeout in milliseconds. Raise it for slow local models. |

The API logs one line at start describing what it will use. Check it with
`docker compose logs api | grep "\[BOOT\] LLM"`. With no key on the default
OpenAI URL, extraction is off (sessions are still recorded, but nothing is
extracted from them) and the line says so.

### OpenAI (the default)

```bash
LLM_API_KEY=sk-...          # or OPENAI_API_KEY
# These are the defaults; set them only to change them.
LLM_API_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_EMBEDDING_MODEL=text-embedding-3-small
```

### Ollama (local, no key)

Ollama on the same machine as Docker. The API container reaches the host as
`host.docker.internal`:

```bash
LLM_API_URL=http://host.docker.internal:11434/v1
LLM_API_KEY=
LLM_MODEL=llama3.1
LLM_TIMEOUT_MS=120000
# Optional, for semantic search: run `ollama pull nomic-embed-text` first.
LLM_EMBEDDING_MODEL=nomic-embed-text
```

Two things to get right:

- **Context length.** DeerDawn's extraction prompts are about 4,000 to 6,000
  tokens. Ollama's default context window is smaller, and it truncates the
  prompt without an error, so extraction quietly returns little or nothing.
  Start Ollama with a larger window, for example
  `OLLAMA_CONTEXT_LENGTH=8192 ollama serve` (or set it in its systemd unit or
  the Ollama app settings). 8192 or more.
- **Reachability.** The bundled `docker-compose.yml` already maps
  `host.docker.internal` to the host (`extra_hosts: host.docker.internal:host-gateway`),
  which Linux needs and Docker Desktop provides anyway. Ollama listens only on
  `127.0.0.1` by default; on Linux, let containers reach it with
  `OLLAMA_HOST=0.0.0.0 ollama serve`.

### OpenRouter

```bash
LLM_API_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=openai/gpt-4o-mini
# Leave LLM_EMBEDDING_MODEL unset: OpenRouter serves no embeddings, and the
# built-in local embedding is used instead.
```

### Which model

- **Recommended:** `gpt-4o-mini` or a model of that class, or a local instruct
  model of 14B parameters or more.
- **Works, with more misses:** 7B to 8B instruct models such as `llama3.1`.
- **Not recommended:** anything under 7B.
- **Avoid reasoning models that think aloud** before answering. DeerDawn caps
  each extraction answer at 640 tokens, and a model that spends them on its
  reasoning returns nothing usable.

If briefs come back thin, try a larger model before anything else.

## Plain HTTP and localhost

The API runs with `NODE_ENV=production`, so it expects HTTPS. On a self-hosted
install, plain HTTP is accepted when the address is the machine itself:
`localhost`, `127.0.0.1` or `::1`, on any port. That is what the quickstart's
`http://localhost:3000` uses. Browsers treat these addresses as secure, and
nothing crosses a network.

Over plain HTTP at any other address (a LAN IP, a hostname, a public IP), the
API answers every request with `https_required` and a message saying how to
set up HTTPS. Signing in would not work anyway: the browser drops the secure
session cookie, and MCP clients would send credentials unencrypted. To use
DeerDawn from other machines, give it a domain and HTTPS (next section). If
TLS already ends at a proxy of your own in front of DeerDawn, set
`DEERDAWN_PUBLIC_URL` to its `https://` address and that counts as HTTPS.

## HTTPS with your own domain

1. Create a DNS `A` (and/or `AAAA`) record for, say, `deerdawn.example.com`
   pointing at the machine.
2. Open ports 80 and 443 to the internet. Port 80 is needed for the
   certificate challenge and redirects to 443.
3. Set these in `.env` (or start over with
   `./scripts/selfhost/init.sh --domain deerdawn.example.com`, which writes them):

   ```bash
   COMPOSE_FILE=docker-compose.yml:infra/selfhost/docker-compose.https.yml
   DEERDAWN_DOMAIN=deerdawn.example.com
   DEERDAWN_PUBLIC_URL=https://deerdawn.example.com
   ```

4. `docker compose up -d`. Caddy gets a Let's Encrypt certificate on the first
   request and renews it on its own. Certificates are kept in the `caddy_data`
   volume.

`COMPOSE_FILE` adds the HTTPS overlay to every `docker compose` command, so
there is still nothing extra to type.

**Behind your own reverse proxy or load balancer instead**: keep the default
(plain HTTP) mode, set `DEERDAWN_BIND_ADDRESS` / `DEERDAWN_HTTP_PORT` to where
your proxy can reach Caddy, set `DEERDAWN_PUBLIC_URL` to the HTTPS address
people use, and forward everything to that port. Forward the `Host` and
`X-Forwarded-*` headers, and do not buffer responses: the MCP endpoint streams.

## Backups

A backup is two things, and it is useless without both:

1. **The database.**

   ```bash
   docker compose exec -T postgres pg_dump -U deerdawn -Fc deerdawn > deerdawn-$(date +%F).dump
   ```

   Run it on a schedule (cron) and copy the files off the machine.

2. **`ENCRYPTION_MASTER_KEY`** from `.env`. Back it up once, separately from
   the database dumps. Briefs and other context are stored encrypted with keys
   that are themselves wrapped by this one. A dump restored without the same
   master key cannot be decrypted, and nothing can recover a lost key. Keep a
   copy of the whole `.env` too; it holds the other secrets.

Redis holds only caches, rate-limit counters and short-lived state; it does not
need backing up.

**Restore** onto a fresh install that uses the **same** `.env`:

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U deerdawn -d deerdawn --clean --if-exists < deerdawn-2026-01-31.dump
docker compose up -d
```

## Upgrading

```bash
git pull                     # picks up compose/Caddy changes
docker compose pull          # new images (or: docker compose build)
docker compose up -d         # recreates changed containers; migrations run on start
```

Take a backup first. To stay on a specific release, set `DEERDAWN_VERSION` in
`.env` (for example `DEERDAWN_VERSION=1.2.0`) instead of `latest`, and change it
when you choose to upgrade. Migrations only move forward, so going back to an
older image after a migration ran means restoring the backup.

## Configuration reference

Everything lives in `.env` at the repository root. `.env.selfhost.example` is
the annotated template.

| Variable | Default | Meaning |
|---|---|---|
| `DEERDAWN_PUBLIC_URL` | `http://localhost:3000` | The address people and MCP clients use. Scheme, host and optional port; no path. |
| `DEERDAWN_HTTP_PORT` | `3000` | Host port Caddy listens on in plain-HTTP mode. |
| `DEERDAWN_BIND_ADDRESS` | `127.0.0.1` | Host interface for that port. `0.0.0.0` exposes it to your network. |
| `DEERDAWN_DOMAIN` | | HTTPS mode only: the domain Caddy gets a certificate for. |
| `SELF_HOSTED` | `true` | Billing off, third-party vendors optional, local auth. Always on in this compose file. |
| `SIGNUP_MODE` | `invite_only` | `invite_only`: the first signup becomes the owner, then invitations only. `open`: anyone who can reach the URL can sign up. See [Sign-up and invitations](#sign-up-and-invitations). |
| `TELEMETRY_ENABLED` | `false` | See [Telemetry](#telemetry). |
| `SOURCE_CODE_URL` | `https://github.com/HissingSpider/DeerDawn` | Where the dashboard's "Source code" link (Settings) points. DeerDawn's server is AGPL-3.0: if you run a **modified** version that other people use over the network, section 13 requires you to offer them its source, so set this to your fork. Must be an `http(s)://` URL. |
| `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_EMBEDDING_MODEL`, `LLM_TIMEOUT_MS` | | See [Choosing an LLM](#choosing-an-llm). |
| `RESEND_API_KEY` | | Outbound email (invitations, password resets). Unset: links go to the API log. |
| `DEERDAWN_ADDONS`, `ADDON_STORAGE_DIR`, `ADDON_S3_*`, `ADDON_MAX_*`, `LLM_VISION_MODEL` | | Add-ons and where their images are stored (a volume at `/data/addons` by default). See [Add-ons](add-ons.md#running-add-ons-on-your-own-server). |
| `POSTGRES_PASSWORD` | generated | Password of the bundled Postgres. |
| `JWT_SECRET` | generated | Signs dashboard sessions. Changing it signs everyone out. |
| `DEERDAWN_SYSTEM_API_KEY` | generated | A full-access machine key the API accepts in `X-Api-Key`. Keep it private. |
| `ENCRYPTION_MASTER_KEY` | generated | 64 hex characters. **Back it up; never change it** on an install that has data. |
| `DEERDAWN_IMAGE_REGISTRY` | `ghcr.io/hissingspider` | Where images are pulled from. |
| `DEERDAWN_VERSION` | `latest` | Image tag. Pin a release for predictable upgrades. |
| `COMPOSE_FILE` | | Set to include `infra/selfhost/docker-compose.https.yml` for HTTPS mode. |

Every other variable in `.env` is passed through to the API, so optional
integrations documented in `apps/api/.env.example` (outbound email through
Resend, a `GITHUB_TOKEN` for skill imports, `DOCS_ENABLED=true` for the API
reference at `/docs`) work by adding them to `.env`. Variables marked
`[HOSTED-ONLY]` there are for the deerdawn.com service and are not needed.

## License and your modifications

DeerDawn's server and dashboard are open source under the
[GNU AGPL v3.0](../LICENSE) (the client packages are MIT; see
[LICENSING.md](../LICENSING.md)). Running it unmodified, for yourself or your
whole company, asks nothing of you. If you change the code and let other people
use your changed version over a network, AGPL section 13 requires you to offer
those users the source of your version: push it somewhere they can reach and set
`SOURCE_CODE_URL` to it, and the dashboard's "Source code" link (on Settings)
will point there.

## Telemetry

A self-hosted DeerDawn sends no product telemetry unless you set
`TELEMETRY_ENABLED=true` in `.env` (which turns on the API's product events,
and only if you also give it an analytics key of your own). The dashboard
image is built as a self-hosted build with telemetry off and loads no
analytics, ad or Vercel scripts. The images are built without any analytics or
error-reporting keys, Sentry is off unless you set `SENTRY_DSN`, and Caddy runs
with its admin API disabled. The only outbound connections your install makes
on its own are to the LLM endpoint you configure, to Let's Encrypt in HTTPS
mode, and to any integration you explicitly enable (email, GitHub, Slack,
Google).

## Troubleshooting

**`init.sh` says `.env` already exists.** It never overwrites one, so it cannot
destroy your encryption key. Edit `.env` by hand, or move it aside and run
`init.sh` again **only** on an install with no data you need.

**`docker compose up` fails with "run scripts/selfhost/init.sh first".**
There is no `.env`, or it is missing a required secret. Run the script.

**The API container restarts or stays `unhealthy`.** Read its log:
`docker compose logs api`. A line starting `CRITICAL:` names the missing or
invalid setting. Common ones: `ENCRYPTION_MASTER_KEY must be a 64-character hex`
(the key was edited or truncated), or a database connection error (check
`docker compose ps postgres`).

**The dashboard container exits with "DEERDAWN_PUBLIC_URL must look like...".**
The URL must be `http://host`, `https://host` or with a `:port`, with no path
and no trailing text.

**The page loads but signing in or anything else does nothing.** You are
probably opening DeerDawn at a different address than `DEERDAWN_PUBLIC_URL`
(for example `127.0.0.1` instead of `localhost`, or a LAN IP). The dashboard
only talks to the API at the configured address. Use that exact URL, or change
`DEERDAWN_PUBLIC_URL` and run `docker compose up -d`.

**Requests fail with `https_required`.** You reached the install over plain
HTTP at an address other than localhost. See
[Plain HTTP and localhost](#plain-http-and-localhost).

**Sign-up says `signup_invite_required`.** The install already has its owner
and `SIGNUP_MODE` is `invite_only`. Ask the owner for an invitation (see
[Sign-up and invitations](#sign-up-and-invitations)).

**Port 3000 (or 80/443) is already in use.** Set `DEERDAWN_HTTP_PORT` to a free
port and update `DEERDAWN_PUBLIC_URL` to match. In HTTPS mode, stop whatever
else is listening on 80 and 443.

**No certificate in HTTPS mode.** `docker compose logs caddy`. Usually the DNS
record does not point at this machine yet, or port 80 is blocked by a firewall
or cloud security group.

**Sessions save but briefs never gain decisions or tasks.** Extraction is
failing. `docker compose logs api | grep -i -E "llm|extract|openai"`. Check
`LLM_API_URL`, `LLM_API_KEY` and `LLM_MODEL`; for Ollama, check the container
can reach it: `docker compose exec api node -e "fetch(process.env.LLM_API_URL + '/models').then(r => console.log(r.status))"`.

**An MCP client cannot connect.** `curl <DEERDAWN_PUBLIC_URL>/.well-known/oauth-protected-resource`
must return JSON naming `<DEERDAWN_PUBLIC_URL>/mcp`. If it names a different
host, `DEERDAWN_PUBLIC_URL` is wrong. ChatGPT and other cloud-hosted clients
additionally need a public HTTPS address.

**Starting over.** `docker compose down -v` deletes the database and every
other volume. Only do this on purpose.
