// Which API the copy-paste setup values in connectCopy.ts point at.
//
// Every command and config in connectCopy.ts names the API a tool should connect to. On a
// self-hosted install that is the install's own public origin, not
// api.deerdawn.com, or a self-hoster would copy a command that connects them to
// the hosted service. The origin is the one this build talks to
// (NEXT_PUBLIC_API_URL), taken only when the build is self-hosted
// (DD_SELF_HOSTED, inlined by next.config.ts from SELF_HOSTED; see
// lib/deployment.ts). The Docker image is built that way, with a placeholder
// NEXT_PUBLIC_API_URL its entrypoint rewrites to DEERDAWN_PUBLIC_URL, so these
// constants read the real origin at runtime. A hosted build (DD_SELF_HOSTED
// unset) gets exactly the hosted literals: every value is byte-identical to what
// it was, which the marketing mirror test and the shared-context contract test
// pin. Read with literal process.env.* names so Next inlines them.
export const HOSTED_API_URL = 'https://api.deerdawn.com';

function selfHostedApiOrigin(): string | null {
  if (String(process.env.DD_SELF_HOSTED || '').trim().toLowerCase() !== 'true') return null;
  const raw = String(process.env.NEXT_PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+$/.test(raw) && raw !== HOSTED_API_URL ? raw : null;
}

/** The self-hosted origin these values point at, or null on a hosted build. */
export const SELF_HOSTED_API_URL: string | null = selfHostedApiOrigin();

/** A hosted copy-paste value, pointed at this deployment's API. Identity on hosted. */
export function forThisDeployment(hostedValue: string): string {
  return SELF_HOSTED_API_URL ? hostedValue.split(HOSTED_API_URL).join(SELF_HOSTED_API_URL) : hostedValue;
}

