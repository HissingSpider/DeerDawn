/**
 * What kind of deployment this dashboard is talking to.
 *
 * DeerDawn is open source (AGPL-3.0). A SELF-HOSTED install (API started with
 * SELF_HOSTED=true) has every feature unlocked and no billing at all, so the
 * dashboard must not draw plan badges, upgrade banners, the billing page or a
 * checkout. Hosted (deerdawn.com) is unchanged.
 *
 * Two sources, for two different questions:
 *
 *   - RUNTIME, from the API (GET /api/v1/public/deployment, also echoed on the
 *     dashboard bootstrap as `deployment`). This is the truth for everything the
 *     user can see: billing UI, sign-up mode. It works whatever the image was
 *     built with, because the API is the one that knows.
 *
 *   - BUILD TIME, `DD_SELF_HOSTED` / `DD_TELEMETRY_ENABLED`, inlined by
 *     next.config.ts from the same SELF_HOSTED / TELEMETRY_ENABLED variables the
 *     API reads. Used only for analytics, which must be decided before anything
 *     loads: a tag that fires while we wait for the API has already sent its
 *     beacon. Self-hosted builds load no analytics unless TELEMETRY_ENABLED=true.
 */
import useSWR from 'swr';
import { getApiBaseUrl } from '@/lib/api';
import { clientTelemetryAllowed, isSelfHostedBuild } from '@/lib/telemetryGate';

export { clientTelemetryAllowed, isSelfHostedBuild };

export type DeploymentInfo = {
  self_hosted: boolean;
  billing_enabled: boolean;
  telemetry_enabled: boolean;
  signup_mode: 'open' | 'invite_only';
  auth_provider: 'clerk' | 'local';
  /**
   * Where the source of the RUNNING version lives (AGPL-3.0 section 13: a
   * modified version offered over a network must offer its users the source).
   * The API reads SOURCE_CODE_URL; an operator of a modified fork points it at
   * the fork. Shown as the "Source code" row on Settings.
   */
  source_code_url: string;
};

/** The upstream repository: what an API too old to say anything links to. */
export const DEFAULT_SOURCE_CODE_URL = 'https://github.com/HissingSpider/DeerDawn';

/** Only an absolute http(s) URL may become a link; anything else is upstream. */
export function safeSourceCodeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_SOURCE_CODE_URL;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw.trim() : DEFAULT_SOURCE_CODE_URL;
  } catch {
    return DEFAULT_SOURCE_CODE_URL;
  }
}

/** Hosted defaults: what an API too old to answer is assumed to be. */
export const HOSTED_DEPLOYMENT: DeploymentInfo = {
  self_hosted: false,
  billing_enabled: true,
  telemetry_enabled: true,
  signup_mode: 'open',
  auth_provider: 'clerk',
  source_code_url: DEFAULT_SOURCE_CODE_URL,
};

/** Normalise whatever the API answered into a full DeploymentInfo. */
export function parseDeployment(raw: unknown): DeploymentInfo {
  if (!raw || typeof raw !== 'object') {
    return isSelfHostedBuild()
      ? { ...HOSTED_DEPLOYMENT, self_hosted: true, billing_enabled: false, telemetry_enabled: clientTelemetryAllowed(), signup_mode: 'invite_only', auth_provider: 'local' }
      : HOSTED_DEPLOYMENT;
  }
  const r = raw as Partial<DeploymentInfo>;
  const selfHosted = r.self_hosted === true || isSelfHostedBuild();
  return {
    self_hosted: selfHosted,
    billing_enabled: selfHosted ? false : r.billing_enabled !== false,
    telemetry_enabled: r.telemetry_enabled !== false,
    signup_mode: r.signup_mode === 'invite_only' ? 'invite_only' : 'open',
    auth_provider: r.auth_provider === 'local' ? 'local' : 'clerk',
    source_code_url: safeSourceCodeUrl(r.source_code_url),
  };
}

let inflight: Promise<DeploymentInfo> | null = null;

/** One request per page load, unauthenticated, never throws. */
export function fetchDeployment(): Promise<DeploymentInfo> {
  if (inflight) return inflight;
  inflight = fetch(`${getApiBaseUrl()}/api/v1/public/deployment`, { credentials: 'omit' })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
    .then(parseDeployment);
  return inflight;
}

/**
 * The deployment, for components. `deployment` is null until the API answers;
 * `selfHosted` is already true for a self-hosted build, so billing UI is never
 * flashed on one while the request is in flight.
 */
export function useDeployment(): { deployment: DeploymentInfo | null; selfHosted: boolean } {
  const { data } = useSWR('public-deployment', fetchDeployment, {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    dedupingInterval: 60 * 60 * 1000,
  });
  return {
    deployment: data ?? null,
    selfHosted: Boolean(data?.self_hosted) || isSelfHostedBuild(),
  };
}

/**
 * The invitation token a sign-up is carrying, from the return URL the invite
 * page sent the reader to the sign-up form with (`/invite?token=...`). A
 * self-hosted install in invite_only mode refuses a sign-up without it.
 */
export function inviteTokenFromReturnPath(returnPath: string | null | undefined): string | null {
  if (!returnPath) return null;
  try {
    const url = new URL(returnPath, 'http://local.invalid');
    if (url.pathname !== '/invite') return null;
    const token = url.searchParams.get('token');
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}
