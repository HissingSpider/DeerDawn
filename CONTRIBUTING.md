# Contributing to DeerDawn

Thanks for your interest in DeerDawn. Bug reports, fixes, documentation and
ideas are all welcome. This page explains how to get set up and how to get a
change merged.

## Before you start

- **Small fixes** (typos, docs, an obvious bug with a test): open a pull
  request directly.
- **Anything larger** (a new feature, a schema change, a change to an MCP
  tool's name or arguments): open an issue or a
  [discussion](https://github.com/HissingSpider/DeerDawn/discussions) first so
  we can agree on the approach before you spend time on it. MCP tool names and
  arguments are a published contract that AI clients depend on, so they change
  rarely and deliberately.
- **Security issues**: do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Where discussion happens

- [Issues](https://github.com/HissingSpider/DeerDawn/issues): bugs, concrete
  feature requests, and self-hosting problems (there is a template for each).
- [Discussions](https://github.com/HissingSpider/DeerDawn/discussions):
  questions, ideas, and anything you are not sure is a bug.
- Pull requests: review of a specific change.

## Contributor License Agreement

Before your first pull request can be merged you need to sign the
[Contributor License Agreement](CLA.md). A bot will comment on your pull
request with instructions; signing takes one comment and covers all your
future contributions. If you contribute as part of your job, check with your
employer first; your employer may need to sign a corporate CLA (see section 9
of the CLA).

We use a CLA rather than a DCO because the project offers the server code
under the AGPL and also under commercial licenses (dual licensing), and that
needs a license to every contribution beyond the AGPL. Your contribution stays
yours; the CLA gives the project a license to it.

## Development setup

You need Node.js (the version in [`.nvmrc`](.nvmrc)), npm, and Docker.

```bash
git clone https://github.com/HissingSpider/DeerDawn.git && cd DeerDawn
npm install
make up         # start the local stack (API on :8080, Postgres, Redis)
make migrate    # run database migrations
make seed       # seed local data
make verify     # check the context-sync flow end to end
```

`make logs` follows the stack's logs and `make down` stops it and removes its
volumes. The local stack is defined in `infra/docker-compose.yml`. To run your
own server rather than develop on it, see
[docs/self-hosting.md](docs/self-hosting.md).

The API needs at least `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`,
`DEERDAWN_API_KEY` and `OPENAI_API_KEY`; the Docker Compose stack supplies
development values for everything except `OPENAI_API_KEY`.

## Running tests and linters

Run the checks for the parts you changed. CI runs all of them.

```bash
# API
bash apps/api/scripts/bootstrap-test-db.sh   # once, to create the test database
cd apps/api && npm test
cd apps/api && npm run lint

# Dashboard and marketing site
npm test -w dashboard && npm run lint -w dashboard
npm test -w marketing && npm run lint -w marketing

# Packages
npm test -w @deerdawn/shared-context
npm test -w @deerdawn/tool-adapters
npm test -w @deerdawn/mcp-server && npm run lint -w @deerdawn/mcp-server
```

## Code layout and conventions

- `apps/api`, `packages/shared-context` and `packages/tool-adapters` are
  CommonJS. `apps/dashboard` and `apps/marketing` are TypeScript and Next.js
  (Pages Router). `packages/mcp-server` is TypeScript, built with tsup.
- The local MCP server (`packages/mcp-server`) and the hosted MCP endpoint
  (`apps/api/src/routes/mcp.js`) implement the same tools. A change to one
  usually needs the same change in the other.
- Every user-visible behaviour change needs a test. A bug fix should come with
  a test that fails without the fix.
- No emojis and no gradients in UI or copy.

## Pull requests

- Keep each pull request to one change. Split unrelated fixes.
- Describe what changed and why, and how you tested it. The pull request
  template has a checklist.
- Make sure CI is green. If a check fails for a reason unrelated to your
  change, say so in the pull request.
- Use clear commit messages; [Conventional
  Commits](https://www.conventionalcommits.org) style (`fix(api): ...`,
  `feat(dashboard): ...`) is preferred.
- A maintainer will review your pull request. We may ask for changes, or
  explain why a change does not fit the project.

## Licensing of your contribution

Contributions to `apps/` and the rest of the server are released under the
[AGPL-3.0-only](LICENSE); contributions to `packages/` and `sdks/` under MIT.
See [LICENSING.md](LICENSING.md).

## Code of Conduct

Everyone taking part in this project is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
