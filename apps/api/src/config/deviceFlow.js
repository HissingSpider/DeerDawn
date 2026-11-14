'use strict';

// The device-flow timings, in one place because two modules have to agree on
// them. routes/shared/mcp-auth.js issues the window and advertises the polling
// interval; middleware/rateLimit.js has to size the poll budget from the same
// numbers. While they lived only in the route, the limiter mounted over it was
// sized by guess — 30 requests per 10 minutes, against a route that asks its
// client for one request every two seconds for up to half an hour.

const DEVICE_CODE_TTL = 600;           // 10 minutes — clients that poll a fixed window
const EXTENDED_DEVICE_CODE_TTL = 1800; // 30 minutes — clients that poll until we say stop

// The `interval` /start advertises, in seconds. A client that honours it sends
// one poll per interval for as long as the code lives.
const DEVICE_POLL_INTERVAL_SECONDS = 2;

// The shape /start mints: 16 random bytes as hex. A poll presenting anything
// else is not carrying a code this server ever issued.
const DEVICE_CODE_PATTERN = /^[a-f0-9]{32}$/;

module.exports = {
    DEVICE_CODE_TTL,
    EXTENDED_DEVICE_CODE_TTL,
    DEVICE_POLL_INTERVAL_SECONDS,
    DEVICE_CODE_PATTERN,
};
