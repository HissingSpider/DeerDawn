import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeerdawnClient } from '../src/client.js';
import { handleContextSyncTool } from '../src/tools/context-sync.js';
import { MAX_TRAIL_CHARS } from '../../shared-context/src/index.js';

/**
 * import_trail accepts a URL, because packs are distributed as links and
 * "download this, then find where it saved, then pass the path" is three steps
 * an agent gets wrong in front of a first-time user.
 *
 * The fetch runs HERE, in the MCP runtime on the user's machine, never by
 * handing the URL to the API — a server that fetches caller-supplied URLs is an
 * SSRF primitive aimed at its own network. These tests pin that the runtime does
 * the fetching, that it refuses plain http off-loopback, and that a failed fetch
 * says what went wrong instead of surfacing an axios stack.
 */

const TRAIL_BODY = JSON.stringify({ format: 'dawn', format_version: 1, manifest: {}, content: {} });

let host: http.Server;
let api: http.Server;
let client: DeerdawnClient;
let baseUrl: string;
/** Bodies the fake API received, so we can assert the fetched bytes got there. */
const importedBodies: any[] = [];
/** When set, the next import answers as the API does at the Done cap. */
let evictedOnImport: Array<{ id: string; title: string }> | null = null;

beforeAll(async () => {
  host = http.createServer((req, res) => {
    if (req.url === '/pack.dawn') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(TRAIL_BODY);
    }
    if (req.url === '/huge.dawn') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('x'.repeat(6 * 1024 * 1024));
    }
    if (req.url === '/oversize.dawn') {
      // Under the 5MB download cap, over the size the API accepts as contents.
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('x'.repeat(MAX_TRAIL_CHARS + 1));
    }
    if (req.url === '/empty.dawn') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('   ');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;

  api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      importedBodies.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        applied: true,
        project_id: 'project_target',
        project_name: 'Target',
        plan: { applied: { decisions: 1 }, skipped_brief_fields: ['current_task', 'goals'] },
        conflicts: [],
        ...(evictedOnImport ? { evicted_cards: evictedOnImport } : {}),
      }));
      evictedOnImport = null;
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  client = new DeerdawnClient({
    apiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    apiKey: 'dev-key',
    environment: 'sandbox',
    cacheEnabled: false,
  } as any);
});

afterAll(async () => {
  await new Promise<void>((r) => host.close(() => r()));
  await new Promise<void>((r) => api.close(() => r()));
});

describe('import_trail from a URL', () => {
  it('fetches the .dawn in the runtime and posts its bytes to the API', async () => {
    const result = await handleContextSyncTool('manage_memory', {
      action: 'import_trail',
      trail: `${baseUrl}/pack.dawn`,
      project_id: 'project_target',
    }, client as any);

    // The API received CONTENTS, not a URL: it never fetches on our behalf.
    const sent = importedBodies.at(-1);
    expect(sent.trail).toBe(TRAIL_BODY);
    expect(String(sent.trail)).not.toContain('http://');
    expect((result as any).content[0].text).toContain('Imported into Target');
  });

  it('reports the brief fields a pack carried but did not donate', async () => {
    const result = await handleContextSyncTool('manage_memory', {
      action: 'import_trail',
      trail: `${baseUrl}/pack.dawn`,
      project_id: 'project_target',
    }, client as any);
    const text = (result as any).content[0].text;
    expect(text).toContain('not applied');
    expect(text).toContain('current_task, goals');
  });

  // Fetch failures come back as readable text, not as a thrown Error: the
  // runtime's error wrapper deliberately collapses Error messages to
  // "Operation failed (Error)", which would strand the agent on a typo.
  const importFrom = async (url: string) => {
    const result: any = await handleContextSyncTool('manage_memory', {
      action: 'import_trail',
      trail: url,
    }, client as any);
    return result.content[0].text as string;
  };

  it('refuses plain http off loopback', async () => {
    const text = await importFrom('http://packs.example.com/pack.dawn');
    expect(text).toMatch(/https/i);
    // Refused before any request went out.
    expect(importedBodies.some((body) => String(body.trail).includes('packs.example.com'))).toBe(false);
  });

  it('says which URL failed and how', async () => {
    expect(await importFrom(`${baseUrl}/missing.dawn`)).toMatch(/HTTP 404/);
    expect(await importFrom(`${baseUrl}/empty.dawn`)).toMatch(/empty body/);
  });

  it('caps the download rather than merging an arbitrarily large file', async () => {
    const text = await importFrom(`${baseUrl}/huge.dawn`);
    expect(text).toMatch(/could not fetch|larger than/i);
    expect(importedBodies.some((body) => String(body.trail).length > 5 * 1024 * 1024)).toBe(false);
  });

  it('refuses a Trail over the size the API accepts before sending it, and says so', async () => {
    const before = importedBodies.length;
    const text = await importFrom(`${baseUrl}/oversize.dawn`);
    expect(text).toMatch(/larger than/i);
    expect(text).toContain(String(MAX_TRAIL_CHARS));
    expect(importedBodies.length).toBe(before);
  });
});

// Scan 13 PARITY: importing a Trail's finished cards into a Done column at its
// cap pushes the user's own cards off the board, and the API names them in
// `evicted_cards` (services/trail). The hosted dispatcher has said so since
// #530; the local reply gave the applied count alone over the loss.
describe('import_trail at the Done cap', () => {
  it('names the cards the import pushed off the board, in the hosted wording', async () => {
    evictedOnImport = Array.from({ length: 7 }, (_, i) => ({ id: `todo_${i}`, title: `Shipped widget ${i}` }));
    const result: any = await handleContextSyncTool('manage_memory', {
      action: 'import_trail',
      trail: TRAIL_BODY,
      project_id: 'project_target',
    }, client as any);
    const text = result.content[0].text as string;
    expect(text).toContain('Imported into Target');
    expect(text).toContain('The board is at its card limit, so 7 cards did not stay on it: "Shipped widget 0", "Shipped widget 1", "Shipped widget 2", "Shipped widget 3", "Shipped widget 4" and 2 more.');
  });

  it('says nothing about the board when nothing was evicted', async () => {
    const result: any = await handleContextSyncTool('manage_memory', {
      action: 'import_trail',
      trail: TRAIL_BODY,
      project_id: 'project_target',
    }, client as any);
    expect(result.content[0].text).not.toContain('card limit');
  });
});
