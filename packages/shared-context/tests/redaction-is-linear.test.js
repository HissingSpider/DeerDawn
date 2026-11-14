'use strict';

// Redaction must stay linear in the size of the text it is given.
//
// These patterns run at PERSIST time on arbitrary user content — a brief is a
// thing someone pastes into — so a quadratic pattern is not a slow function, it
// is a write path that stops. Measured before the bounds went on:
//
//     8 KB     38 ms
//    20 KB    228 ms
//    40 KB    897 ms
//   200 KB  23,016 ms
//
// Four times the text, sixteen times the work. The offender was not the pattern
// that looks most alarming: SC_ASSIGNMENT's lookahead and the unclosed-quote
// alternation cost under a millisecond between them, while SC_URI_CREDS' scheme
// matcher `[a-z0-9+.-]*` — three characters of regex — consumed the whole run at
// every starting position and accounted for essentially all of it. That is why
// this test measures instead of reading.
//
// Run: node --test tests/redaction-is-linear.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecretText } = require('../src/index.js');

function millis(text) {
  const started = process.hrtime.bigint();
  redactSecretText(text);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test('a large brief is redacted in linear time, not quadratic', () => {
  // Ratios rather than absolute milliseconds: a shared CI runner is noisy, and
  // the property under test is the SHAPE of the curve. Quadratic would put this
  // at ~100x; linear puts it near 10x. The threshold sits far from both.
  const small = 'API_KEY: ' + 'a'.repeat(20_000);
  const large = 'API_KEY: ' + 'a'.repeat(200_000);

  millis(small); // warm the JIT so the first call is not the measured one
  const smallMs = Math.max(millis(small), 0.5);
  const largeMs = millis(large);

  assert.ok(
    largeMs / smallMs < 30,
    `10x the input should not cost ~100x the time: ${smallMs.toFixed(1)}ms -> ${largeMs.toFixed(1)}ms `
    + `(ratio ${(largeMs / smallMs).toFixed(1)}x). A ratio near 100 means an unbounded quantifier came back.`,
  );
});

test('each shape that was pathological is now cheap', () => {
  // One case per pattern that had an open-ended quantifier, so a regression
  // names the pattern that regressed instead of just "redaction got slow".
  const cases = [
    ['unbroken run after a key name', 'API_KEY: ' + 'a'.repeat(200_000)],
    ['unclosed quote', 'TOKEN: "' + 'a'.repeat(200_000)],
    ['uri scheme that never resolves', 'postgres://' + 'a'.repeat(200_000)],
  ];
  for (const [name, text] of cases) {
    const ms = millis(text);
    assert.ok(ms < 2000, `${name}: took ${ms.toFixed(0)}ms on 200 KB, which is the quadratic signature`);
  }
});

test('bounding the quantifiers did not stop it redacting', () => {
  // The bounds are worthless if they were bought by letting a secret through,
  // so every pattern that gained a ceiling gets a real value through it.
  const secrets = [
    ['uri credentials', 'postgres://user:s3cretPassw0rd@db.example.com:5432/app'],
    ['auth header', 'Authorization: Bearer abcdefgh12345678ABCDEF'],
    ['quoted json value', '{"api_key": "sk-abcdefghijklmnop1234"}'],
    ['bare assignment', 'DATABASE_PASSWORD=hunter2hunter2-99'],
  ];
  for (const [name, text] of secrets) {
    assert.match(redactSecretText(text), /\[REDACTED\]/, `${name} must still be redacted`);
  }
});

test('and did not start mangling prose', () => {
  // The value guard exists because redaction runs at persist time and destroyed
  // real notes: "ADMIN_PASSWORD: contact support" became "[REDACTED] support",
  // irreversibly. Bounding a quantifier must not widen what matches.
  for (const prose of ['ADMIN_PASSWORD: contact support', 'the auth: middleware runs first']) {
    assert.equal(redactSecretText(prose), prose, `prose must survive untouched: ${prose}`);
  }
});
