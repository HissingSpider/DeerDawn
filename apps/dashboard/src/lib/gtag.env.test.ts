// Imported before ./gtag by gtag.test.ts: the Ads id has no built-in default
// any more (it is read only from NEXT_PUBLIC_GOOGLE_ADS_ID), so the conversion
// tests name a placeholder account. Module evaluation order is import order.
process.env.NEXT_PUBLIC_GOOGLE_ADS_ID = process.env.NEXT_PUBLIC_GOOGLE_ADS_ID || 'AW-TEST';
// Same for the conversion labels: no defaults in code, so name distinct
// placeholders (two actions sharing a label would merge in Google Ads).
process.env.NEXT_PUBLIC_GADS_FIRST_SYNC_LABEL = process.env.NEXT_PUBLIC_GADS_FIRST_SYNC_LABEL || 'test-first-sync';
process.env.NEXT_PUBLIC_GADS_SIGNUP_LABEL = process.env.NEXT_PUBLIC_GADS_SIGNUP_LABEL || 'test-signup';
process.env.NEXT_PUBLIC_GADS_CONNECT_ATTEMPTED_LABEL = process.env.NEXT_PUBLIC_GADS_CONNECT_ATTEMPTED_LABEL || 'test-connect-attempted';
export {};
