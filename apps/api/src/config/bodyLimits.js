'use strict';

// JSON body limits for the routes that carry a .dawn archive as contents: the
// REST import (POST /api/v1/context/trail/import) and every MCP endpoint, where
// manage_memory(action:"import_trail") sends it inside a tool call.
//
// Sized from MAX_TRAIL_CHARS rather than typed as its own number, because the
// field validator and the parser in front of it have to agree: a 256kb parser in
// front of the trail field limit refuses with a bare 413 long before
// validation can say anything useful. JSON escaping at most doubles a string
// (quotes, backslashes, \n, \r, \t; other control characters are refused), plus
// headroom for the rest of the request envelope.
//
// Every other route keeps DEFAULT_JSON_BODY_LIMIT.
const {
  MAX_TRAIL_CHARS,
  MAX_EXTRACTION_BODY_BYTES,
} = require('../../../../packages/shared-context/src/index.js');

const DEFAULT_JSON_BODY_LIMIT = '256kb';
const TRAIL_JSON_BODY_LIMIT = MAX_TRAIL_CHARS * 2 + 64 * 1024;

// POST /api/v1/context/extraction — where the end-of-session flush posts a whole
// transcript. Named rather than left on the default, because a client has to be
// able to size itself against it: the MCP flush reads the same constant from
// shared-context and trims to fit, instead of finding the cap by being refused
// and losing the session. Equal to the default today; the point is that it can
// no longer move by accident when the default does.
//
// It stays small deliberately — this parser, like the MCP one, runs before
// authentication, so every byte allowed is a byte an unauthenticated caller can
// make the server buffer. Client-side trimming is the right side to solve this
// on; the end of a session is the part worth keeping.
const EXTRACTION_JSON_BODY_LIMIT = MAX_EXTRACTION_BODY_BYTES;
const EXTRACTION_BODY_PATH = '/api/v1/context/extraction';

module.exports = {
  DEFAULT_JSON_BODY_LIMIT,
  TRAIL_JSON_BODY_LIMIT,
  MAX_TRAIL_CHARS,
  EXTRACTION_JSON_BODY_LIMIT,
  EXTRACTION_BODY_PATH,
};
