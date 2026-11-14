const DEFAULT_PRIMARY_SITE_URL = 'https://deerdawn.com';
const DEFAULT_PRIMARY_APP_URL = 'https://app.deerdawn.com';

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

const primarySiteUrl = trimTrailingSlash(process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_PRIMARY_SITE_URL);
const primaryAppUrl = trimTrailingSlash(process.env.NEXT_PUBLIC_APP_URL || DEFAULT_PRIMARY_APP_URL);

// DeerDawn is context-sync only; the dual-brand (governance) machinery was removed.
export const siteConfig = {
  PRIMARY_SITE_URL: primarySiteUrl,
  PRIMARY_APP_URL: primaryAppUrl,
  SELF_APP_URL: primaryAppUrl,
  LINKED_SITE_URL: primarySiteUrl,
  ACTIVE_SITE_URL: primarySiteUrl,
  ACTIVE_APP_URL: primaryAppUrl,
};
