let status = 'ready';
let error = null;

function setBootstrapStarting() {
  status = 'starting';
  error = null;
}

function setBootstrapReady() {
  status = 'ready';
  error = null;
}

function setBootstrapFailed(err) {
  status = 'failed';
  error = err?.message || String(err || 'bootstrap_failed');
}

function getBootstrapState() {
  return {
    status,
    ready: status === 'ready',
    error,
  };
}

module.exports = {
  getBootstrapState,
  setBootstrapStarting,
  setBootstrapReady,
  setBootstrapFailed,
};
