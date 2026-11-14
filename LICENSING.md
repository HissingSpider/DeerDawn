# Licensing

DeerDawn is open source under two OSI-approved licenses. Which one applies
depends on the directory a file lives in.

| Path | License | Why |
|---|---|---|
| `apps/` (API, dashboard, marketing site, simulator, video) | [AGPL-3.0-only](LICENSE) | The server and the hosted product |
| `infra/`, `scripts/`, `docs/`, `e2e/`, `packs/` and everything else not listed below | [AGPL-3.0-only](LICENSE) | Same |
| `packages/mcp-server` | [MIT](packages/mcp-server/LICENSE) | Runs on your machine; published to npm as `@deerdawn/mcp-server` |
| `packages/shared-context` | [MIT](packages/shared-context/LICENSE) | Bundled into the published MCP server |
| `packages/tool-adapters` | [MIT](packages/tool-adapters/LICENSE) | Client-side tool profiles; kept with the other client code |
| `packages/addon-kit` | [MIT](packages/addon-kit/LICENSE) | The add-on interface: manifest schema, validator, types (see [docs/add-ons.md](docs/add-ons.md)) |
| `sdks/` | MIT (see each SDK's `LICENSE`) | Client libraries |

A `LICENSE` file inside a directory applies to that directory. Everything else
is covered by the root [`LICENSE`](LICENSE): the GNU Affero General Public
License, version 3 only.

## Copyright

Copyright (C) 2026 John Gilbert.

<!-- Placeholder: the copyright holder is the individual project owner until a
legal entity exists to hold it. Update this line, CLA.md, TRADEMARK.md and the
MIT LICENSE files together when one does. -->

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, version 3 of the License.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

## The short version

You can run DeerDawn yourself, change it, and use it for anything you like,
including commercially. If you change it and let other people use your changed
version over a network, you must offer those people the source of your changes.

This page is a plain-language guide, not legal advice; the [license
text](LICENSE) is what governs.

## What the AGPL lets you do

- **Self-host it**, for yourself or your whole company, with every feature
  unlocked and no licence key.
- **Modify it** and run your modified version.
- **Use it commercially**, including inside a for-profit company and for
  clients.
- **Read it, fork it, and redistribute it**, modified or not, as long as you
  keep the license and copyright notices and pass on the same freedoms.

## What the AGPL asks of you

- **If you distribute it** (hand someone a copy, a binary or a container image),
  you must make the corresponding source available to them under the AGPL.
- **If you modify it and let others use it over a network** (section 13), you
  must offer every user who interacts with your modified version a way to get
  its source code, under the AGPL. Running an unmodified copy, or a modified copy
  that only you use, asks nothing extra of you.

To make section 13 easy, the dashboard shows a "Source code" link. It points to
this repository by default; if you run a modified fork, set `SOURCE_CODE_URL` to
your fork (see [docs/self-hosting.md](docs/self-hosting.md)).

## Commercial license

If your organisation cannot accept the AGPL's terms, for example because you
want to ship a modified DeerDawn without publishing your changes, a commercial
license is available from the copyright holder. Email john@deerdawn.com.

## Why the client packages are MIT

Anything you install on your own machine to talk to a DeerDawn server (the MCP
server, the SDKs, and the code they bundle) is MIT, so that connecting your
tools to DeerDawn never puts copyleft obligations on your machine, your
employer, or a package you build on top of it. `packages/shared-context` is
compiled into the published `@deerdawn/mcp-server`, so it has to carry the same
license or the npm package would inherit the AGPL.

## Add-ons

DeerDawn is getting an add-on system. Two things about its licensing are
settled now, so nobody has to guess later:

- The add-on interface (the manifest format, its schemas, and any helper
  package published for writing add-ons) will be MIT, like the other client
  packages.
- An add-on that is only data (a manifest, record schemas, instructions for
  the agent, view definitions) is yours to license however you like. DeerDawn
  reads it; nothing in it is linked into the server.

An add-on that ships code which runs inside the AGPL-licensed server is a
different case. Treat it as covered by the AGPL unless you have a commercial
license.

## Trademarks

Neither license grants rights to the DeerDawn name or logo. Forks must use a
different name. See [TRADEMARK.md](TRADEMARK.md).

## Contributions

Contributions are accepted under the [Contributor License Agreement](CLA.md).
It lets the project offer the code under these licenses and also under
commercial licenses (dual licensing), which is how organisations that cannot use
the AGPL can still license DeerDawn.
