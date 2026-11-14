# DeerDawn native MCP submission pack

Last verified in source: 2026-08-09

## Product identity

- Name: DeerDawn
- Publisher: DeerDawn Inc.
- Category: Productivity / Developer tools / AI memory
- Availability: Public, global where the directory permits
- OpenAI MCP endpoint: `https://api.deerdawn.com/mcp`
- Claude MCP endpoint: `https://api.deerdawn.com/mcp/claude`
- Homepage: `https://deerdawn.com`
- Documentation: `https://deerdawn.com/docs/mcp-server`
- Support: `support@deerdawn.com` and `https://deerdawn.com/contact`
- Privacy: `https://deerdawn.com/privacy`
- Terms: `https://deerdawn.com/terms`
- Status: `https://deerdawn.com/status`
- Square logo: `https://deerdawn.com/brand-mark.png` (512 x 512 PNG)
- Company address: DeerDawn Inc., 1209 Orange Street, Wilmington, DE 19801

## Listing copy

Short description (94 characters):

> AI session memory that briefs every new assistant with the state of your active project.

Long description:

> DeerDawn keeps a structured project brief—current task, status, decisions, goals, open questions, and useful technical context—and makes it available through one authenticated MCP connection. Start a session in ChatGPT, Codex, Claude, or another compatible client to resume without re-explaining the project. Save progress and decisions as work changes, search across project context, and use the shared task board to keep handoffs aligned. DeerDawn stores structured context rather than full conversation transcripts and gives users export, revocation, and deletion controls.

## Starter prompts

1. “Start my DeerDawn session and tell me what I was working on.”
2. “List my DeerDawn projects, then open the launch project.”
3. “Show the current task, recent decisions, and open questions for this project.”
4. “Save that OAuth review passed and move the matching launch card to Testing.”
5. “Search DeerDawn for prior decisions about refresh-token rotation.”
6. “Build a compact DeerDawn subagent brief for verifying the MCP auth flow.”

The executable expected tools, arguments, results, negative cases, authentication cases, and isolation fixtures are in `docs/launch/native-mcp-review-cases.json`.

## Authentication and reviewer access

- OAuth 2.1 Authorization Code with PKCE.
- `context:read` and `context:write` are requested per tool and enforced server-side.
- Universal multi-tenant endpoint; do not select a workspace-template URL.
- Review account must be created in the production Clerk tenant as a persistent password user with no MFA, OTP, email-code, invite, or company-network dependency. A local-only DeerDawn password account is not sufficient when Clerk is authoritative because it cannot approve the OAuth grant.
- Seed the review account by running `node apps/api/scripts/seed-native-reviewer.js` with a reviewer-scoped API key. Never put the password or key in this document, Git, a URL, or a submission screenshot.

## v1 surface declaration

Version 1 is intentionally headless and MCP-only. It returns no embedded UI resources and has no ChatGPT- or Claude-specific interface. Both directory endpoints share the same production backend, OAuth flow, data, and handlers. The OpenAI catalog keeps the seven grouped tools submitted at `/mcp`; the Claude catalog at `/mcp/claude` splits task-board reads from mutations to satisfy Anthropic's read/write separation policy. Do not upload product-UI screenshots for the OpenAI submission, but do provide the required Developer Mode demo recording of the app running inside ChatGPT.

## OpenAI demo recording

Record the supported ChatGPT web experience in Developer Mode at 1920x1080. Use only the seeded `Aurora Launch Review` fixture and keep the DeerDawn app visibly selected. The final cut should be roughly two to three minutes, remove dead waiting time without fabricating results, and show the real tool activity and final responses for these reviewer-reproducible flows:

1. Start the DeerDawn session and show the synthetic current task.
2. Find `Aurora Launch Review` and read its task, recent decisions, and open questions.
3. Save a fictional progress update, including ChatGPT's write confirmation when shown.
4. Read the task board, move `Run reviewer OAuth smoke test` to Testing, and read the board again to prove persistence.
5. Ask one unrelated weather question and show that DeerDawn is not invoked.

Use short title and closing cards only. Do not redact the product result in the final recording; if anything private appears, discard the take and record again against the synthetic reviewer account.

## OpenAI console gates

- Business verification must show the publisher name `DeerDawn` / `DeerDawn Inc.`.
- Acting account must have `api.apps.write`; `api.apps.read` is needed to inspect status.
- Use an OpenAI project with global data residency, not EU residency.
- Scan `https://api.deerdawn.com/mcp`, confirm 7 grouped tools, and attach the review cases.
- Do not submit product-UI screenshots because v1 has no embedded UI. Attach the required real Developer Mode demo recording described above.

## Anthropic console gates

- Submit `https://api.deerdawn.com/mcp/claude` with the same identity, policies, support details, descriptions, and reviewer credentials.
- Confirm the Claude catalog exposes `read_tasks` separately from the write-only `manage_tasks` actions.
- Confirm the directory's current OAuth callback is accepted before final submission.
- Do not claim Claude-exclusive behavior or add a Claude-specific UI.

## Domain challenges

`api.deerdawn.com` resolves to the production API. If a publisher provides a temporary `/.well-known/<filename>` challenge, set `DOMAIN_VERIFICATION_FILENAME` and `DOMAIN_VERIFICATION_CONTENT` on the API service, verify the exact HTTPS response, then unset both after verification.

## Final human-controlled actions

Business identity verification, entering reviewer credentials, accepting submission confirmations/terms, selecting countries, and clicking **Submit for review** must be performed by an authorized DeerDawn/OpenAI or DeerDawn/Anthropic account holder.
