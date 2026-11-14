import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inferDeployTargets } from '../src/project-sync.js';

describe('inferDeployTargets', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-infra-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(rel: string, content: string) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }

  it('infers a Fly.io environment with app + region from fly.toml', () => {
    write('apps/api/fly.toml', "app = 'my-app'\nprimary_region = 'iad'\n");
    const envs = inferDeployTargets(root);
    const fly = envs.find(e => e.canonical_key === 'env:fly:my-app');
    expect(fly).toBeTruthy();
    expect(fly!.title).toBe('my-app — Fly.io');
    expect(fly!.summary).toContain('Fly.io');
    expect(fly!.summary).toContain('iad');
    expect(fly!.entity_type).toBe('environment');
    expect(fly!.scope).toBe('workspace');
    expect(fly!.metadata.source_kind).toBe('inferred');
  });

  it('infers Vercel from .vercel/project.json (real project name) and vercel.json fallback', () => {
    write('apps/dashboard/.vercel/project.json', JSON.stringify({ projectId: 'x', projectName: 'deerdawn_dashboard' }));
    write('apps/marketing/vercel.json', '{}');
    const keys = inferDeployTargets(root).map(e => e.canonical_key);
    expect(keys).toContain('env:vercel:deerdawn_dashboard'); // from project.json name
    expect(keys).toContain('env:vercel:marketing');          // fallback to dir name
  });

  it('infers Render, Netlify, and Procfile hosts', () => {
    write('render.yaml', 'services: []\n');
    write('apps/site/netlify.toml', '[build]\n');
    write('worker/Procfile', 'web: node index.js\n'); // not under a scanned ws dir → ignored
    const keys = inferDeployTargets(root).map(e => e.canonical_key);
    expect(keys).toContain('env:render:' + path.basename(root));
    expect(keys).toContain('env:netlify:site');
    // 'worker/' is not apps|packages|services|libs|modules, so it is not scanned
    expect(keys.some(k => k.startsWith('env:procfile'))).toBe(false);
  });

  it('returns nothing when there is no infra config', () => {
    write('package.json', '{"name":"x"}');
    expect(inferDeployTargets(root)).toEqual([]);
  });

  it('dedupes by canonical_key', () => {
    write('fly.toml', "app = 'dup'\n");
    write('apps/api/fly.toml', "app = 'dup'\n");
    const flies = inferDeployTargets(root).filter(e => e.canonical_key === 'env:fly:dup');
    expect(flies.length).toBe(1);
  });
});
