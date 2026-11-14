// Imported first by connectTarget.test.ts: what next.config.ts inlines into a
// self-hosted build (DD_SELF_HOSTED from SELF_HOSTED, and the API origin).
process.env.DD_SELF_HOSTED = 'true';
process.env.NEXT_PUBLIC_API_URL = 'https://dd.example.com/';
export {};
