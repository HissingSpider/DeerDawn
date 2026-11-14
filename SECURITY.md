# Security Policy

DeerDawn stores the working memory of people's projects, so we take reports
seriously and are grateful for them.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security
problem.**

Report it privately, by either:

1. **GitHub private vulnerability reporting (preferred):** go to the
   [Security tab](https://github.com/HissingSpider/DeerDawn/security/advisories/new)
   of this repository and choose "Report a vulnerability".
2. **Email:** security@deerdawn.com.

Please include:

- what is affected (the hosted service at deerdawn.com, a self-hosted install,
  or the `@deerdawn/mcp-server` package, with the version or commit);
- steps to reproduce, or a proof of concept;
- the impact as you understand it (for example, which data another user or
  workspace could read or change);
- whether you would like to be credited, and under what name.

## What to expect

| Step | Target |
|---|---|
| Acknowledge your report | within 3 business days |
| Initial assessment and severity | within 7 days |
| Fix for critical and high severity issues | as fast as possible, usually within 30 days |
| Fix for other issues | within 90 days |

We will keep you updated as we go, tell you when a fix ships, and agree a
disclosure date with you. We ask that you give us a reasonable chance to fix
the problem before disclosing it publicly, normally 90 days from your report
or when the fix ships, whichever comes first. With your permission, we credit
reporters in the published advisory.

## Supported versions

| Component | Supported |
|---|---|
| Hosted service at deerdawn.com | Always the current deployment |
| Self-hosted server (`apps/`) | The latest release and `main`. Fixes are not backported; please upgrade. |
| `@deerdawn/mcp-server` (npm) | The latest published version |
| Anything under `sdks/python` | Not supported (retired) |

## Scope

In scope: the code in this repository and the hosted service at deerdawn.com,
including the API, the dashboard, the hosted MCP endpoint and the
`@deerdawn/mcp-server` package.

Out of scope: denial of service by volume, social engineering, physical
attacks, reports from automated scanners with no demonstrated impact, and
issues in third-party services we use (please report those to the vendor).

When testing the hosted service, use only accounts you own, do not access or
modify other people's data, and stop and report as soon as you have confirmed
an issue. Good-faith research that follows this policy will not be pursued
legally by us.
