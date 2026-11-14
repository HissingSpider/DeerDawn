import { getAttribution, getClickIds } from '@/lib/attribution';
import { consentRequestId } from '@/lib/authorizeFlow';
import { getDeviceType } from '@/lib/device';

// A type alias, not an interface: Clerk's SignUpUnsafeMetadata has a string
// index signature, which an interface does not satisfy and an alias does.
export type SignupContext = {
  attribution: Record<string, string | undefined>;
  device_type?: string;
  /** The consent request this sign-up started from, when it started on one. */
  oauth_request_id?: string;
};

// First-touch attribution + device travel through Clerk unsafeMetadata so the
// authoritative server-side account_created event (the Clerk user.created webhook,
// which never sees the browser) can attribute the signup to its ad/keyword and
// device — and, for a sign-up that began on a consent screen, to the AI tool it
// was created to connect. Kept small — Clerk caps unsafeMetadata at 8KB.
//
// unsafeMetadata is a SIGN-UP parameter: SignIn.authenticateWithRedirect drops
// it silently. Anything passing this to Google OAuth must start from signUp.
//
// Click ids (gclid/wbraid/gbraid/rdt_cid) come from the .deerdawn.com cookie the
// marketing site sets (getClickIds) and only fill gaps: a value already in this
// origin's first-touch record wins. They are what the Google Ads setup
// conversion is keyed on once this person's tool first receives a brief.
export function signupContext(returnTo?: string | null): SignupContext {
  const oauthRequestId = consentRequestId(returnTo);
  const stored = getAttribution() as Record<string, string | undefined>;
  const attribution: Record<string, string | undefined> = { ...stored };
  for (const [key, value] of Object.entries(getClickIds())) {
    if (value && !attribution[key]) attribution[key] = value;
  }
  return {
    attribution,
    device_type: getDeviceType(),
    ...(oauthRequestId ? { oauth_request_id: oauthRequestId } : {}),
  };
}
