const http = require('http');

let bindCheckResult = null;

async function canBindLoopback() {
  if (bindCheckResult !== null) return bindCheckResult;

  bindCheckResult = await new Promise((resolve) => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const finish = (value) => {
      bindCheckResult = value;
      resolve(value);
    };

    server.once('error', () => finish(false));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => finish(true));
    });
  });

  return bindCheckResult;
}

async function ensureHttpBindingAvailable(t, label = 'HTTP-bound test suite') {
  const available = await canBindLoopback();
  if (available) return true;
  t.diagnostic(`Skipping ${label}: loopback port binding is unavailable in this environment`);
  t.skip(`HTTP binding unavailable for ${label}`);
  return false;
}

module.exports = {
  ensureHttpBindingAvailable,
};
