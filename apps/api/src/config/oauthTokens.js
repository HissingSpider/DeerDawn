'use strict';

// OAuth token lifetimes, in one place because two modules have to agree on
// them and, when they quietly stopped agreeing, nothing said so.
//
// ACCESS_TOKEN_TTL_DAYS and REFRESH_TTL_SECONDS were both 90 days, minted in
// the same breath by routes/oauth.js. A refresh token that dies at the same
// instant as the access token it refreshes is not a refresh token: the client
// notices the 401, presents the refresh grant, and the Redis key is already
// gone, so every hosted connection needed fresh consent at day 90. The refresh
// token must outlive the access token by a wide margin — wide enough that a
// client which only ever refreshes on expiry still finds it there.
//
// REFRESH_INDEX_TTL_SECONDS is the erasure index in services/dataErasureService.js:
// the only thing that can find a person's live refresh tokens, since a token's
// Redis key is a hash of the token itself. It was 45 days against a comment
// saying REFRESH_TTL was 30 — it had been 90 for some time, so the index was
// already expiring while the tokens it pointed at were still live, and an
// erased account could refresh its way back to a working key. It is derived
// here so that cannot drift again.

const ACCESS_TOKEN_TTL_DAYS = 90;
const REFRESH_TTL_SECONDS = 365 * 24 * 60 * 60;

// Comfortably past the longest-lived token it can point at. A stale member
// costs one wasted DEL; a missing one costs a credential that survives its own
// erasure.
const REFRESH_INDEX_TTL_SECONDS = REFRESH_TTL_SECONDS + 35 * 24 * 60 * 60;

module.exports = {
    ACCESS_TOKEN_TTL_DAYS,
    REFRESH_TTL_SECONDS,
    REFRESH_INDEX_TTL_SECONDS,
};
