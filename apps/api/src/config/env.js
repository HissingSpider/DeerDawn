const { isSelfHosted, dashboardBaseUrl } = require('./selfHosted');

// HOSTED PRODUCTION requires the whole vendor stack; a SELF-HOSTED install
// requires only what it cannot run without. Both are strict: each refuses to
// boot rather than run half-configured. The hosted list is unchanged by
// self-hosted mode existing; SELF_HOSTED=true is the only way around it.
const HOSTED_PRODUCTION_REQUIRED = Object.freeze([
    'DATABASE_URL',
    'REDIS_URL',
    'DEERDAWN_API_KEY',
    'JWT_SECRET',
    'DASHBOARD_URL',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'CLERK_SECRET_KEY',
    'CLERK_WEBHOOK_SECRET',
    'ENCRYPTION_MASTER_KEY',
    // Required for context sync (LLM extraction pipeline)
    'OPENAI_API_KEY',
]);

// Postgres and a session secret. Redis falls back to redis://localhost:6379
// below; the LLM key is checked by the extraction pipeline, which names the
// provider it needs. No Clerk, Stripe, PostHog, Resend or Fly.
const SELF_HOSTED_PRODUCTION_REQUIRED = Object.freeze([
    'DATABASE_URL',
    'JWT_SECRET',
]);

const selfHosted = isSelfHosted();

function selfHostedLlmConfigured(env) {
  if (env.OPENAI_API_KEY || env.LLM_API_KEY) return true;
  const url = String(env.LLM_API_URL || '').trim();
  if (!url) return false;
  try {
    return !/(^|\.)openai\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

if (process.env.NODE_ENV === 'production' && selfHosted) {
  console.log('[BOOT] Self-hosted production environment detected. Validating configuration...');
  const minSecretLength = 32;
  SELF_HOSTED_PRODUCTION_REQUIRED.forEach((v) => {
    if (!process.env[v]) {
      throw new Error(`CRITICAL: ${v} is missing. Self-hosted launch blocked.`);
    }
  });
  const weak = (value) => !value || value.length < minSecretLength || new Set(value).size < 10 || /(.)\1{7,}/.test(value);
  if (weak(process.env.JWT_SECRET)) {
    throw new Error(`CRITICAL: JWT_SECRET is too weak. Use a secret with at least ${minSecretLength} characters and sufficient entropy.`);
  }
  // Optional on a self-host (it gates only the system key), but never weak.
  if (process.env.DEERDAWN_API_KEY && weak(process.env.DEERDAWN_API_KEY)) {
    throw new Error(`CRITICAL: DEERDAWN_API_KEY is too weak. Use at least ${minSecretLength} characters, or leave it unset.`);
  }
  // Encryption at rest is opt-in on a self-host, but a malformed key would
  // fail every write that tries to use it.
  if (process.env.ENCRYPTION_MASTER_KEY && !/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_MASTER_KEY)) {
    throw new Error('CRITICAL: ENCRYPTION_MASTER_KEY must be a 64-character hex AES-256 key. Self-hosted launch blocked.');
  }
  // Clerk is allowed on a self-host, but only fully configured.
  if (process.env.AUTH_PROVIDER === 'clerk' && !process.env.CLERK_SECRET_KEY) {
    throw new Error('CRITICAL: AUTH_PROVIDER=clerk requires CLERK_SECRET_KEY. Unset AUTH_PROVIDER to use local email/password sign-in.');
  }
  // The extraction LLM. OPENAI_API_KEY or LLM_API_KEY is a key; LLM_API_URL
  // pointing anywhere but OpenAI (a local Ollama, say) needs none. Without any
  // of them every brief update would fail, so refuse to boot.
  if (!selfHostedLlmConfigured(process.env)) {
    throw new Error('CRITICAL: no LLM configured. Set OPENAI_API_KEY or LLM_API_KEY, or LLM_API_URL for a keyless local model (e.g. Ollama). Self-hosted launch blocked.');
  }
  if (!process.env.PUBLIC_URL && !process.env.DASHBOARD_URL) {
    console.warn('[BOOT] Neither PUBLIC_URL nor DASHBOARD_URL is set: invitation and password-reset links will point at http://localhost:3000.');
  }
}

if (process.env.NODE_ENV === 'production' && !selfHosted) {
  console.log('[BOOT] Production environment detected. Validating secrets...');
  const criticalVars = HOSTED_PRODUCTION_REQUIRED;

  const minSecretLength = 32;
  const minUniqueChars = 10;

  const isWeakSecret = value => {
    if (!value || value.length < minSecretLength) {
      return true;
    }
    const uniqueChars = new Set(value).size;
    if (uniqueChars < minUniqueChars) {
      return true;
    }
    return /(.)\1{7,}/.test(value);
  };

  criticalVars.forEach(v => {
    const value = process.env[v];
    if (!value) {
      throw new Error(`CRITICAL: ${v} is missing. Production launch blocked.`);
    }
    if (['DEERDAWN_API_KEY', 'JWT_SECRET'].includes(v) && isWeakSecret(value)) {
      throw new Error(
        `CRITICAL: ${v} is too weak. Use a secret with at least ${minSecretLength} characters and sufficient entropy.`
      );
    }
  });

  if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_MASTER_KEY)) {
    throw new Error('CRITICAL: ENCRYPTION_MASTER_KEY must be a 64-character hex AES-256 key. Production launch blocked.');
  }

  if (process.env.AUTH_PROVIDER !== 'clerk') {
    throw new Error('CRITICAL: AUTH_PROVIDER must be set to clerk in production. Production launch blocked.');
  }

  if (process.env.ALLOW_LOCAL_JWT_FALLBACK === 'true') {
    throw new Error('CRITICAL: ALLOW_LOCAL_JWT_FALLBACK must be disabled in production. Production launch blocked.');
  }

  // SLACK_OAUTH_STATE_SECRET belongs here, not in criticalVars: requiring it
  // unconditionally hard-failed production boot for every deploy that never intended to
  // use Slack, while .env.example groups all four Slack vars together as optional.
  const slackVars = ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_SIGNING_SECRET', 'SLACK_OAUTH_STATE_SECRET'];
  const hasSlackConfig = slackVars.some(v => process.env[v]);
  if (hasSlackConfig) {
    slackVars.forEach(v => {
      const value = process.env[v];
      if (!value) {
        throw new Error(`CRITICAL: ${v} is missing. Slack integration requires all Slack secrets.`);
      }
    });
  }

  const googleOAuthVars = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
    'GOOGLE_OAUTH_STATE_SECRET',
  ];
  const hasGoogleOAuthConfig = googleOAuthVars.some(v => process.env[v]);
  if (hasGoogleOAuthConfig) {
    googleOAuthVars.forEach(v => {
      if (!process.env[v]) {
        throw new Error(`CRITICAL: ${v} is missing. Google context sources require all Google secrets.`);
      }
    });
  }

    const maskedRedis = process.env.REDIS_URL.replace(/:[^:@]+@/, ':***@');
    console.log(`[BOOT] Redis URL: ${maskedRedis}`);
}

module.exports = {
  PORT: process.env.PORT || 8080,
  API_KEY: process.env.DEERDAWN_API_KEY,
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: (process.env.REDIS_URL && process.env.REDIS_URL !== '') ? process.env.REDIS_URL : 'redis://localhost:6379',
  API_BASE_URL: process.env.API_BASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  // Self-hosted: PUBLIC_URL when DASHBOARD_URL is unset. Hosted: unchanged.
  DASHBOARD_URL: process.env.DASHBOARD_URL || (selfHosted ? dashboardBaseUrl() : 'http://localhost:3000'),
  SELF_HOSTED: selfHosted,
  selfHostedLlmConfigured,
  HOSTED_PRODUCTION_REQUIRED,
  SELF_HOSTED_PRODUCTION_REQUIRED,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
  // Auth configuration
  AUTH_PROVIDER: process.env.AUTH_PROVIDER || 'local',
  // Allow local JWT fallback even when AUTH_PROVIDER=clerk in production.
  ALLOW_LOCAL_JWT_FALLBACK: process.env.ALLOW_LOCAL_JWT_FALLBACK === 'true',
  // Optional local JWT issuer/audience validation.
  JWT_ISSUER: process.env.JWT_ISSUER,
  JWT_AUDIENCE: process.env.JWT_AUDIENCE,
  SLACK_CLIENT_ID: process.env.SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET: process.env.SLACK_CLIENT_SECRET,
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  SLACK_OAUTH_STATE_SECRET: process.env.SLACK_OAUTH_STATE_SECRET,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  GOOGLE_OAUTH_STATE_SECRET: process.env.GOOGLE_OAUTH_STATE_SECRET,

    // Zendesk OAuth
    ZENDESK_CLIENT_ID: process.env.ZENDESK_CLIENT_ID,
    ZENDESK_CLIENT_SECRET: process.env.ZENDESK_CLIENT_SECRET,

    // Intercom OAuth
    INTERCOM_CLIENT_ID: process.env.INTERCOM_CLIENT_ID,
    INTERCOM_CLIENT_SECRET: process.env.INTERCOM_CLIENT_SECRET,

    // Extraction LLM
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,

    // Performance optimization feature flags
    ENABLE_API_KEY_CACHE: process.env.ENABLE_API_KEY_CACHE !== 'false', // Default ON
    ENABLE_REDIS_IDEMPOTENCY: process.env.ENABLE_REDIS_IDEMPOTENCY !== 'false', // Default ON
    ENABLE_REDIS_ONLY_COUNTERS: process.env.ENABLE_REDIS_ONLY_COUNTERS !== 'false', // Default ON

    // Database pool configuration
  DB_POOL_MAX: parseInt(process.env.DB_POOL_MAX || '10', 10),
  DB_POOL_MIN: parseInt(process.env.DB_POOL_MIN || '0', 10)
};
