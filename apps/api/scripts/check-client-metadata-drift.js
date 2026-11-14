#!/usr/bin/env node
'use strict';

// Does what our OAuth clients publish still match what we tested against?
//
// tests/fixtures/oauth-real-clients.json holds documents captured verbatim from
// third parties. Those documents are theirs, not ours: they can change without
// a commit here, and when they do, every test in this repo keeps passing while
// production breaks for every new user. That is precisely how `claude mcp add`
// came to return a bare 400 to everyone (PR #445) — nothing we owned was wrong,
// and nothing we ran could tell.
//
// This fetches each `source_url` and reports the difference. It is deliberately
// NOT a deploy gate: it depends on someone else's uptime, and the repo already
// learned what a third-party signal wired into `needs:` does (see the
// security-audit comment in ci.yml — a transitive CVE silently blocked three
// consecutive Fly deploys). It runs on a schedule and is read by a human.
//
// Exit codes:  0 = in sync   1 = drifted, act on it   2 = could not check

const path = require('path');

const FIXTURE = path.resolve(__dirname, '../tests/fixtures/oauth-real-clients.json');
const TIMEOUT_MS = 10000;

// Fields we actually depend on. A client adding an unrelated key is not drift;
// a client changing where its authorization code may be delivered is.
const MATERIAL_FIELDS = [
  'client_id',
  'redirect_uris',
  'grant_types',
  'response_types',
  'token_endpoint_auth_method',
  'token_endpoint_auth_methods_supported',
];

function normalize(value) {
  if (Array.isArray(value)) return [...value].sort();
  return value;
}

function describe(value) {
  return value === undefined ? '(absent)' : JSON.stringify(normalize(value));
}

async function fetchMetadata(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(await response.text());
}

async function main() {
  const fixture = require(FIXTURE);
  const clients = Array.isArray(fixture.clients) ? fixture.clients : [];
  // An empty fixture must not read as "everything is in sync" — that is the
  // silent-success shape this whole exercise is about.
  if (clients.length === 0) {
    console.error('FIXTURE EMPTY: no captured clients to check. This is a broken check, not a pass.');
    return 2;
  }

  let drifted = 0;
  let unreachable = 0;

  for (const client of clients) {
    let live;
    try {
      live = await fetchMetadata(client.source_url);
    } catch (err) {
      unreachable += 1;
      console.warn(`?  ${client.label}: could not fetch ${client.source_url} — ${err.message}`);
      continue;
    }

    const differences = MATERIAL_FIELDS
      .filter((field) => JSON.stringify(normalize(live[field])) !== JSON.stringify(normalize(client.metadata[field])))
      .map((field) => `     ${field}: captured ${describe(client.metadata[field])} -> live ${describe(live[field])}`);

    if (differences.length === 0) {
      console.log(`ok ${client.label} (captured ${client.captured_at}) matches ${client.source_url}`);
      continue;
    }

    drifted += 1;
    console.error(`DRIFT ${client.label} — ${client.source_url}`);
    differences.forEach((line) => console.error(line));
  }

  if (drifted > 0) {
    console.error('');
    console.error(`${drifted} client document(s) moved since capture.`);
    console.error('Do NOT just re-capture the fixture. Check whether /authorize still accepts every');
    console.error('redirect_uri the live document declares, in the form the client actually sends it');
    console.error('(a portless loopback entry arrives WITH an ephemeral port), then update the fixture');
    console.error('with the server fix in the same commit.');
    return 1;
  }
  if (unreachable === clients.length) {
    console.error('No client document could be fetched — this run proved nothing.');
    return 2;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('check-client-metadata-drift failed:', err.message);
    process.exit(2);
  });
