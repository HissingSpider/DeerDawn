'use strict';

// Preloaded into the dashboard's Node server (node --require). Self-hosting only.
//
// The dashboard and the API share one public origin (DEERDAWN_PUBLIC_URL), and
// a few dashboard server routes (pages/api/oauth-*.ts, mcp-authorize.ts) call
// the API at that origin. From inside the container the public origin may not
// be reachable at all (http://localhost:3000 is the container itself), so any
// server-side fetch aimed at the public origin is sent to the API service
// directly instead (DEERDAWN_INTERNAL_API_URL, default http://api:8080).
// Browser code is unaffected: this runs in the server process only.
//
// A rewritten request also says which public origin it stands for
// (X-Forwarded-Host / X-Forwarded-Proto, which the API trusts from its one proxy
// hop). Without them the API sees host "api" over plain HTTP: a self-hosted
// install refuses plain HTTP to anything but localhost, and refuses MCP/OAuth
// over plain HTTP, so the consent pages would fail on every install.

const publicUrl = (process.env.DEERDAWN_PUBLIC_URL || '').replace(/\/+$/, '');
const internalUrl = (process.env.DEERDAWN_INTERNAL_API_URL || 'http://api:8080').replace(/\/+$/, '');

if (publicUrl && typeof globalThis.fetch === 'function') {
  let publicOrigin;
  try {
    publicOrigin = new URL(publicUrl).origin;
  } catch {
    publicOrigin = null;
  }
  if (publicOrigin) {
    const originalFetch = globalThis.fetch;
    const rewrite = (url) => {
      if (typeof url !== 'string' || !url.startsWith(publicOrigin)) return url;
      const rest = url.slice(publicOrigin.length);
      if (rest !== '' && !rest.startsWith('/') && !rest.startsWith('?')) return url;
      return internalUrl + rest;
    };
    const forwarded = new URL(publicOrigin);
    const withForwarded = (headers) => {
      const h = new Headers(headers || undefined);
      if (!h.has('x-forwarded-host')) h.set('x-forwarded-host', forwarded.host);
      if (!h.has('x-forwarded-proto')) h.set('x-forwarded-proto', forwarded.protocol.replace(/:$/, ''));
      return h;
    };
    const send = (url, init) => {
      const next = rewrite(url);
      if (next === url) return originalFetch(url, init);
      return originalFetch(next, { ...(init || {}), headers: withForwarded(init && init.headers) });
    };
    globalThis.fetch = function deerdawnInternalFetch(input, init) {
      if (typeof input === 'string') return send(input, init);
      if (input instanceof URL) return send(input.href, init);
      if (input && typeof input.url === 'string') {
        const next = rewrite(input.url);
        if (next !== input.url) {
          const request = new Request(next, input);
          return originalFetch(new Request(request, { ...(init || {}), headers: withForwarded((init && init.headers) || request.headers) }));
        }
      }
      return originalFetch(input, init);
    };
  }
}
