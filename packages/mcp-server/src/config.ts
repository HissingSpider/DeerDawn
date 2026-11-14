import { z } from 'zod';

function isLocalApiUrl(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

const ConfigSchema = z.object({
  apiUrl: z.string().url().default('https://api.deerdawn.com'),
  // Trimmed BEFORE validation and storage. The refinement below always checked
  // the trimmed value but the raw one was stored, so a key pasted with a trailing
  // newline passed validation and then went out in the x-api-key header, where
  // the HTTP client rejects the control character and the server died at boot.
  // A key that is only whitespace is treated as absent, so the device flow runs.
  apiKey: z.preprocess(
    (v) => (typeof v === 'string' ? (v.trim() || undefined) : v),
    z.string().min(1).optional(),
  ),
  orgId: z.string().optional(),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  cacheEnabled: z.boolean().default(true),
  cacheTtlSeconds: z.number().int().min(1).max(3600).default(60),
  maxRetries: z.number().int().min(0).max(5).default(3),
  retryBackoffMs: z.number().int().min(100).max(10000).default(1000),
}).superRefine((config, ctx) => {
  if (!config.apiKey) return; // no key yet — device flow will run

  const apiKey = config.apiKey.trim();
  const local = isLocalApiUrl(config.apiUrl);
  const hasDdPrefix = /^dd_[a-z0-9_]+$/i.test(apiKey);

  if (local) {
    if (apiKey.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: 'Local development API key is too short',
      });
    }
    return;
  }

  if (!hasDdPrefix) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKey'],
      message: 'API key must start with dd_ prefix',
    });
    return;
  }

  if (apiKey.length <= 10) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apiKey'],
      message: 'API key too short',
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  try {
    const rawConfig = {
      apiUrl: process.env.DEERDAWN_API_URL,
      apiKey: process.env.DEERDAWN_API_KEY,
      orgId: process.env.DEERDAWN_ORG_ID,
      environment: process.env.DEERDAWN_ENVIRONMENT,
      cacheEnabled: process.env.DEERDAWN_CACHE_ENABLED !== 'false',
      cacheTtlSeconds: process.env.DEERDAWN_CACHE_TTL_SECONDS
        ? Number(process.env.DEERDAWN_CACHE_TTL_SECONDS)
        : undefined,
      maxRetries: process.env.DEERDAWN_MAX_RETRIES
        ? Number(process.env.DEERDAWN_MAX_RETRIES)
        : undefined,
      retryBackoffMs: process.env.DEERDAWN_RETRY_BACKOFF_MS
        ? Number(process.env.DEERDAWN_RETRY_BACKOFF_MS)
        : undefined,
    };

    return ConfigSchema.parse(rawConfig);
  } catch (error) {
    // Never log validation errors that might contain API keys
    if (error instanceof z.ZodError) {
      // Redact sensitive fields from issues
      const sanitizedIssues = error.issues.map(issue => ({
        ...issue,
        path: issue.path.includes('apiKey') ? ['apiKey'] : issue.path,
        message: issue.path.includes('apiKey') ? 'API key validation failed' : issue.message,
      }));
      const sanitizedError = new Error('Configuration validation failed. Check your environment variables.');
      sanitizedError.name = 'ConfigValidationError';
      (sanitizedError as any).issues = sanitizedIssues;
      throw sanitizedError;
    }
    throw error;
  }
}
