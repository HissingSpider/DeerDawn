import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentSessionId, getAgentSessionContext } from '../src/agent-session.js';
import { recordBriefWatermark, checkStale, resetWatermarks } from '../src/session-watermark.js';
import { findOverlappingPeers, readPeerMirror, writePeerMirror, MIRROR_TTL_MS, PEER_MIRROR_PATH } from '../src/peer-mirror.js';

describe('agent session identity', () => {
  it('is stable across calls within a process', () => {
    // The bug this replaces: `mcp-${Date.now()}` minted a new id per write, so no
    // two calls from one agent were ever connectable and context_sessions grew an
    // orphan row per update. Presence, holds and staleness are all reads on this.
    expect(getAgentSessionId()).toBe(getAgentSessionId());
  });

  it('is not empty and does not leak a hostname into the id', () => {
    const id = getAgentSessionId();
    expect(id.length).toBeGreaterThan(6);
    expect(id.startsWith('agent-')).toBe(true);
  });

  it('degrades to nulls rather than throwing', () => {
    const ctx = getAgentSessionContext('/tmp/somewhere');
    expect(ctx.cwd).toBe('/tmp/somewhere');
    expect(ctx.status).toBe('active');
  });

  // The raw hostname rode every write as session_context.host and every
  // /active call as a header; the server stored it, made a graph entity of it
  // and printed it into the brief's handoff line. It identifies the person or
  // their employer and nothing needs it, so it is not sent at all.
  it('never carries the machine hostname', () => {
    const ctx = getAgentSessionContext('/tmp/somewhere');
    // ABSENT, not null: the API's schema is `host: z.string().optional()`, so a
    // null host is a 400 and every local update failed with it (scan 12).
    expect('host' in ctx).toBe(false);
    for (const value of Object.values(ctx)) expect(value).not.toBeNull();
    const hostname = os.hostname();
    if (hostname) expect(JSON.stringify(ctx)).not.toContain(hostname);
  });
});

describe('brief staleness watermark', () => {
  beforeEach(() => resetWatermarks());

  it('says nothing when no brief was ever recorded', () => {
    // Silence beats a banner we cannot justify.
    expect(checkStale('proj-1', '2026-08-20T10:00:00Z')).toBeNull();
  });

  it('says nothing while the brief is still current', () => {
    recordBriefWatermark('proj-1', '2026-08-20T10:00:00Z');
    expect(checkStale('proj-1', '2026-08-20T10:00:00Z')).toBeNull();
    expect(checkStale('proj-1', '2026-08-20T09:00:00Z')).toBeNull();
  });

  it('reports once, then stays quiet for the same change', () => {
    // Otherwise every subsequent call for the rest of the session re-announces
    // one edit, and the model learns to ignore the banner entirely.
    recordBriefWatermark('proj-1', '2026-08-20T10:00:00Z');
    const first = checkStale('proj-1', '2026-08-20T10:05:00Z');
    expect(first?.staleMs).toBe(5 * 60 * 1000);
    expect(checkStale('proj-1', '2026-08-20T10:05:00Z')).toBeNull();
  });

  it('tracks projects independently', () => {
    recordBriefWatermark('proj-1', '2026-08-20T10:00:00Z');
    expect(checkStale('proj-2', '2026-08-20T11:00:00Z')).toBeNull();
  });

  it('ignores unparseable watermarks instead of guessing', () => {
    recordBriefWatermark('proj-1', 'nonsense');
    expect(checkStale('proj-1', 'also-nonsense')).toBeNull();
  });
});

describe('peer mirror', () => {
  let home: string;
  let realHome: string | undefined;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-peers-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (realHome) process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
    try { fs.rmSync(PEER_MIRROR_PATH, { force: true }); } catch { /* best effort */ }
  });

  it('reads back nothing when no mirror exists — never throws', () => {
    // The hook runs in the edit path. Every failure mode must degrade to "warn
    // about nothing", never to an exception and never to a block.
    expect(readPeerMirror('/some/repo')).toEqual([]);
  });

  it('ignores a mirror captured in a different workspace', () => {
    const dir = path.dirname(PEER_MIRROR_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PEER_MIRROR_PATH, JSON.stringify({
      captured_at: new Date().toISOString(),
      cwd: '/other/checkout',
      project_id: 'p1',
      peers: [{ session_id: 'agent-b', scope: ['src/a.js'], held_cards: [] }],
    }));
    expect(readPeerMirror('/this/checkout')).toEqual([]);
  });

  it('ages out a mirror left behind by a crashed process', () => {
    const dir = path.dirname(PEER_MIRROR_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PEER_MIRROR_PATH, JSON.stringify({
      captured_at: new Date(Date.now() - MIRROR_TTL_MS - 1000).toISOString(),
      cwd: '/repo',
      project_id: 'p1',
      peers: [{ session_id: 'agent-b', scope: ['src/a.js'], held_cards: [] }],
    }));
    expect(readPeerMirror('/repo')).toEqual([]);
  });

  it('survives a corrupt mirror', () => {
    const dir = path.dirname(PEER_MIRROR_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PEER_MIRROR_PATH, '{not json');
    expect(readPeerMirror('/repo')).toEqual([]);
  });

  it('writes an empty peer list so departed agents stop being warned about', () => {
    writePeerMirror('/repo', 'p1', []);
    expect(readPeerMirror('/repo')).toEqual([]);
    const raw = JSON.parse(fs.readFileSync(PEER_MIRROR_PATH, 'utf8'));
    expect(raw.peers).toEqual([]);
  });

  it('round-trips peers for the same workspace', () => {
    writePeerMirror('/repo', 'p1', [
      { session_id: 'agent-b', tool: 'cursor', scope: ['apps/api/src/services/trail/index.js'], held_cards: [{ title: 'publish surface' }] },
    ]);
    const peers = readPeerMirror('/repo');
    expect(peers).toHaveLength(1);
    expect(peers[0].session_id).toBe('agent-b');
    expect(peers[0].held_cards).toEqual(['publish surface']);
  });
});

describe('overlap matching', () => {
  const peers = [{ session_id: 'agent-b', scope: ['apps/api/src/services/trail/index.js'], held_cards: [] }];

  it('matches an edit inside a peer scope', () => {
    expect(findOverlappingPeers('apps/api/src/services/trail/index.js', peers)).toHaveLength(1);
  });

  it('does not match an unrelated file', () => {
    expect(findOverlappingPeers('apps/marketing/src/pages/index.tsx', peers)).toHaveLength(0);
  });

  it('ignores scope fragments too short to mean anything', () => {
    // "src" would match the whole repo. A hook that fires on every edit trains
    // the model to ignore it, which is worse than not having the hook at all.
    const noisy = [{ session_id: 'agent-b', scope: ['src'], held_cards: [] }];
    expect(findOverlappingPeers('apps/marketing/src/pages/index.tsx', noisy)).toHaveLength(0);
  });

  it('returns nothing for an empty path rather than matching everything', () => {
    expect(findOverlappingPeers('', peers)).toHaveLength(0);
  });
});
