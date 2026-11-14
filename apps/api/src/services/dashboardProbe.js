// Is the dashboard answering? Measured from the server, for the public /status
// page.
//
// WHY THE SERVER: the page used to fetch the dashboard from the browser with
// mode 'no-cors', which hides the response, so a dashboard answering 500 looked
// exactly like one answering 200. A server-side request can read the status.
//
// Rules, each pinned by tests/unit/dashboard-probe.test.js:
//   - 2xx and 3xx are operational; anything else, a timeout or a refused
//     connection is degraded.
//   - Redirects are never followed (redirect: 'manual'), so the probe cannot be
//     led to a third-party host. A 3xx is an answer, and that is all it is used for.
//   - The URL is DASHBOARD_URL plus a fixed path. Nothing a caller sends reaches it.
//   - The answer is cached for a short time, degraded answers included, and
//     concurrent callers share one in-flight probe. The route is public, so
//     without this it would be a way to point traffic at the dashboard.
//   - No configured dashboard URL is 'unknown': nothing was measured.
//   - The answer carries the state and the time, and nothing else: no status
//     code, no address.

const PROBE_PATH = '/login';
const DEFAULT_TTL_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 4 * 1000;

function createDashboardProbe({
    baseUrl = () => process.env.DASHBOARD_URL,
    fetchImpl = (...args) => globalThis.fetch(...args),
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now,
} = {}) {
    let cached = null;   // { at, result }
    let inflight = null;

    function target() {
        const raw = baseUrl();
        if (!raw || typeof raw !== 'string') return null;
        let url;
        try { url = new URL(raw); } catch { return null; }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        return `${url.origin}${PROBE_PATH}`;
    }

    async function probe() {
        const url = target();
        const stamp = () => new Date(now()).toISOString();
        if (!url) return { dashboard: 'unknown', checked_at: stamp() };
        let state = 'degraded';
        try {
            const res = await fetchImpl(url, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs),
                headers: { 'user-agent': 'deerdawn-status-probe' },
            });
            if (res.status >= 200 && res.status < 400) state = 'operational';
            try { await res.body?.cancel(); } catch { /* the body is not needed */ }
        } catch {
            state = 'degraded';
        }
        return { dashboard: state, checked_at: stamp() };
    }

    async function check() {
        if (cached && now() - cached.at < ttlMs) return cached.result;
        if (!inflight) {
            inflight = probe()
                .then((result) => { cached = { at: now(), result }; return result; })
                .finally(() => { inflight = null; });
        }
        return inflight;
    }

    return { check };
}

const defaultProbe = createDashboardProbe();

module.exports = { createDashboardProbe, checkDashboard: () => defaultProbe.check() };
