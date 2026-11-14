/**
 * Replay ownership on the dashboard: Sentry records, PostHog does not.
 *
 * Until 2026-09-01 PostHog recorded 100% of dashboard sessions, unsampled, with
 * `maskAllInputs: true`. That option masks form fields and NOT rendered text —
 * so the decrypted project briefs this app exists to display were going into
 * the recordings. Sentry replaced it with maskAllText + blockAllMedia, and with
 * a buffer that only uploads when an error actually fires.
 *
 * Flipping `disable_session_recording` back to false is a one-character change
 * that reads as harmless and silently restores both the privacy exposure and
 * the recording volume, so it is pinned here.
 *
 * Source-text assertions, comment-blind: this repo has been caught before by a
 * source assertion passing against a mention in a comment rather than real code.
 */
const test = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');
const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('PostHog does not record sessions on the dashboard', () => {
    const code = stripComments(read('lib/posthog.ts'));

    assert.match(
        code,
        /disable_session_recording:\s*true/,
        'PostHog replay must stay off here — Sentry owns dashboard replay, and ' +
            'PostHog only masks inputs, so rendered brief content lands in the recording.'
    );
    assert.ok(
        !/disable_session_recording:\s*false/.test(code),
        'PostHog session recording was re-enabled on the dashboard.'
    );
});

test('exceptions are not double-reported into two vendors', () => {
    const code = stripComments(read('lib/posthog.ts'));

    assert.match(
        code,
        /capture_exceptions:\s*false/,
        'Sentry owns errors; leaving PostHog autocapture on splits the issue ' +
            'history across two products and reports every error twice.'
    );
});

test('Sentry replay masks content and only uploads on an error', () => {
    const code = stripComments(read('instrumentation-client.ts'));

    assert.match(code, /maskAllText:\s*true/, 'brief content must be masked in the recording itself');
    assert.match(code, /blockAllMedia:\s*true/);

    // 0 session / 1 on-error is what keeps this inside a small replay quota AND
    // what stops speculative recording of sessions where nothing went wrong.
    assert.match(code, /replaysSessionSampleRate:\s*0\b/);
    assert.match(code, /replaysOnErrorSampleRate:\s*1(\.0)?\b/);
});
