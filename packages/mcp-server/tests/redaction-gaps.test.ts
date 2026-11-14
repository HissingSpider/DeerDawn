/**
 * What the local redactor let through.
 *
 * redactSecrets is the last thing between a captured shell command, a session
 * transcript or an imported CLAUDE.md and the network. Each case below is a
 * credential shape that used to leave the machine untouched, asserted the only
 * way that means anything: hand the function the secret, and look for the
 * secret in what comes back.
 *
 * Every fixture is fake and is assembled by concatenation so that no scanner
 * reading this file finds a well-formed token in it.
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/redact.js';

const R = '[REDACTED]';

function expectGone(input: string, ...secrets: string[]) {
  const out = redactSecrets(input);
  for (const secret of secrets) expect(out).not.toContain(secret);
  expect(out).toContain(R);
  return out;
}

describe('redaction gaps', () => {
  describe('HTTP auth headers', () => {
    it('masks a Basic credential, which the bearer-only pattern skipped entirely', () => {
      const b64 = Buffer.from('deploy:' + 'hunter' + 'two').toString('base64');
      const out = expectGone(`curl -H "Authorization: Basic ${b64}" https://api.example.com`, b64);
      expect(out).toContain('Authorization: Basic');
      expect(out).toContain('https://api.example.com');
    });

    it('masks a four-character Basic value (u:p)', () => {
      expectGone('Authorization: Basic dTpw', 'dTpw');
    });

    it('still masks a Bearer token and keeps the scheme word', () => {
      const out = expectGone('Authorization: Bearer abcdefgh' + '12345678ABCDEF', 'abcdefgh12345678');
      expect(out).toContain('Bearer');
    });
  });

  describe('credentials passed as flags', () => {
    it('masks curl -u user:pass and keeps the user name', () => {
      const out = expectGone('curl -u admin:' + 'sw0rdfish https://example.com/x', 'sw0rdfish');
      expect(out).toContain('-u admin:');
      expect(out).toContain('https://example.com/x');
    });

    it('masks a quoted curl --user value with a space in the password', () => {
      const out = expectGone('curl --user "admin:' + 'open sesame" https://example.com', 'open sesame', 'sesame');
      expect(out).toContain('"admin:');
    });

    it('masks mysql -pSECRET and mysql -p SECRET', () => {
      expectGone('mysqldump -u root -p' + 'Tr0ub4dor db > dump.sql', 'Tr0ub4dor');
      expectGone('mysql -h db -u root -p ' + 'Tr0ub4dor app', 'Tr0ub4dor');
    });

    it('masks docker login -p and sshpass -p, and leaves the port that follows alone', () => {
      expectGone('docker login registry.example.com -u me -p ' + 'pw', ' -p pw');
      const out = expectGone('sshpass -p ' + 'letmein ssh -p 2222 me@host', 'letmein');
      expect(out).toContain('ssh -p 2222 me@host');
    });

    it('masks long credential flags at any length, in both = and space form', () => {
      expectGone('deploy --password ' + 'abc', '--password abc');
      expectGone('deploy --token=' + 'x1', '--token=x1');
      expectGone('deploy --api-key ' + 'k', '--api-key k');
      expectGone('npm publish --registry-token ' + 'zz9', 'zz9');
    });

    it('does not mangle ordinary commands that merely look like credential flags', () => {
      const untouched = [
        'ls -p',
        'ls -p /var/lib',
        'grep -u pattern file.txt',
        'git -p log --oneline',
        'mkdir -p src/utils/deep',
        'cp -p a b',
        'ssh -p 2222 me@host',
        'docker run -p 8080:80 -u 1000:1000 nginx',
        'git push -u origin main',
        'rsync -u host:/src/ dest/',
        'psql -p 5432 -U app',
        'docker login -u me --password-stdin',
        'vault login --token-file ./t',
        'mysql -u root -p < schema.sql',
        'brew install mysql && mkdir -p data',
        'export GH_TOKEN=$(gh auth token)',
        'C:\\Users\\dev\\proj> dir /p',
        'node --max-tokens 4096 run.js',
        'Use the --token flag to authenticate, or pass --password on the CLI.',
        'The Authorization: Basic scheme is documented in RFC 7617.',
        'authorization: bearer tokens are required',
        'mysql -u root -p\nuse appdb;\nselect 1;',
        'deploy --password\nnext-line-word',
      ];
      for (const cmd of untouched) expect(redactSecrets(cmd)).toBe(cmd);
    });
  });

  describe('token prefixes', () => {
    const cases: Array<[string, string]> = [
      ['AWS temporary key', 'AS' + 'IA' + 'ABCDEFGHIJKLMNOP'],
      ['Stripe webhook secret', 'wh' + 'sec_' + 'AbCdEfGhIjKlMnOpQrStUvWx'],
      ['npm token', 'np' + 'm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
      ['SendGrid key', 'S' + 'G.' + 'abcdefghijklmnopqrstuv' + '.' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq'],
      ['Fly token (underscore form)', 'Fly' + 'V1_' + 'fm2_lJPECAAAAAAAB0example0token0body'],
      ['Fly token (as flyctl prints it)', 'Fly' + 'V1 ' + 'fm2_lJPECAAAAAAAB0example0token0body'],
      ['bare Fly macaroon', 'fm' + '2_' + 'lJPECAAAAAAAB0example0token0body'],
    ];
    for (const [name, secret] of cases) {
      it(`masks a ${name}`, () => {
        expectGone(`echo ${secret} | tee out.txt`, secret, secret.slice(-12));
      });
    }

    it('does not take npm_config_* env names or pnpm_ identifiers for tokens', () => {
      const text = 'npm_config_registry npm_package_version pnpm_abcdefghijklmnopqrstuvwxyz';
      expect(redactSecrets(text)).toBe(text);
    });
  });

  describe('URI credentials', () => {
    it('masks a password behind an EMPTY user', () => {
      const out = expectGone('redis://:' + 's3cretPassw0rd@cache.example.com:6379/0', 's3cretPassw0rd');
      expect(out).toContain('@cache.example.com:6379/0');
    });

    it('masks the whole of a password that contains @', () => {
      const out = expectGone('postgres://app:' + 'p@ss@w0rd@db.example.com:5432/app', 'p@ss', 'ss@w0rd', 'w0rd');
      expect(out).toContain('postgres://app:');
      expect(out).toContain('@db.example.com:5432/app');
    });

    it('keeps the host and path after a masked token-named user', () => {
      const out = expectGone('git clone https://x-access-token:' + 'abcDEF123@github.com/o/r.git', 'abcDEF123');
      expect(out).toContain('@github.com/o/r.git');
    });

    it('leaves credential-free URLs and compact JSON alone', () => {
      const untouched = [
        'http://localhost:3000/path',
        'ssh://git@github.com:22/org/repo.git',
        'https://example.com:8443/users/@me',
        '{"a":"http://host:80","b":"ops@example.com"}',
        'file:///C:/Users/dev/project',
      ];
      for (const text of untouched) expect(redactSecrets(text)).toBe(text);
    });
  });

  describe('short and letters-only values after an env-style name', () => {
    it('masks them', () => {
      expectGone('PGPASSWORD=' + 'pw1 psql -h db', '=pw1');
      expectGone('DB_PASSWORD=' + 'correcthorse npm start', 'correcthorse');
      expectGone('export MYSQL_PWD=' + 'x9', '=x9');
      expectGone('DJANGO_SECRET_KEY=' + 'abc', '=abc');
    });

    it('does not touch prose, code, or names that are not credentials', () => {
      const untouched = [
        'ADMIN_PASSWORD: contact support',
        'the auth: middleware runs first',
        'login(token=tok)',
        'PWD=/home/dev OLDPWD=/tmp',
        'SORT_KEY=id',
        'MAX_TOKENS=4096',
      ];
      for (const text of untouched) expect(redactSecrets(text)).toBe(text);
    });
  });

  describe('PEM blocks', () => {
    const begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
    const end = '-----END ' + 'RSA PRIVATE KEY-----';
    const body = 'MIIEowIBAAKCAQEAfakefakefakefake\nq1w2e3r4t5y6u7i8o9p0fakefakefake\nZmFrZWZha2VmYWtlZmFrZQ==';

    it('still masks a complete block and keeps what follows it', () => {
      const out = expectGone(`key:\n${begin}\n${body}\n${end}\nafter the key`, 'MIIEowIBAAKCAQEA', 'ZmFrZWZha2U');
      expect(out).toContain('after the key');
    });

    it('masks a TRUNCATED block — BEGIN with no END — through to the end of input', () => {
      const out = expectGone(`cat id_rsa\n${begin}\n${body}`, 'MIIEowIBAAKCAQEA', 'q1w2e3r4t5y6', 'ZmFrZWZha2U');
      expect(out.startsWith('cat id_rsa')).toBe(true);
    });

    it('masks a truncated JSON-escaped block', () => {
      expectGone(`{"private_key":"${begin}\\nMIIEowIBAAKCAQEAfakefake\\nq1w2e3r4t5y6fake`, 'MIIEowIBAAKCAQEA', 'q1w2e3r4t5y6');
    });

    it('a sentence that only mentions the marker does not cost the rest of the document', () => {
      const doc = `The scanner looks for ${begin} (the PEM fence).\n\n## Next section\n\nThis paragraph must survive.`;
      const out = redactSecrets(doc);
      expect(out).toContain('## Next section');
      expect(out).toContain('This paragraph must survive.');
    });
  });

  describe('stays linear', () => {
    function millis(text: string): number {
      const started = process.hrtime.bigint();
      redactSecrets(text);
      return Number(process.hrtime.bigint() - started) / 1e6;
    }

    // One adversarial input per pattern that gained or changed a quantifier, so a
    // regression names the pattern instead of reporting "redaction got slow".
    const shapes: Array<[string, (n: number) => string]> = [
      ['a run of dashes (long-flag lookbehind)', (n) => '-'.repeat(n)],
      ['a long-flag name that never ends', (n) => '--' + 'a'.repeat(n)],
      ['curl with no -u on a huge line', (n) => 'curl ' + 'a '.repeat(n / 2)],
      ['many curls, no -u', (n) => 'curl x '.repeat(n / 7)],
      ['many mysqls, no -p', (n) => 'mysql x '.repeat(n / 8)],
      ['uri scheme that never resolves', (n) => 'postgres://' + 'a'.repeat(n)],
      ['uri password that never reaches @', (n) => 'postgres://u:' + 'a'.repeat(n)],
      ['many uri userinfo starts, no @', (n) => 'a://b:c '.repeat(n / 8)],
      ['unterminated PEM', (n) => '-----BEGIN PRIVATE KEY-----' + 'A'.repeat(n)],
      ['many unterminated PEM fences', (n) => '-----BEGIN PRIVATE KEY-----\n'.repeat(n / 28)],
      ['many END-looking fences after a BEGIN', (n) => '-----BEGIN PRIVATE KEY-----' + '-----END '.repeat(n / 9)],
      ['upper-case run before an env assignment', (n) => 'A'.repeat(n) + '_TOKEN=x'],
      ['unclosed quote after an env name', (n) => 'TOKEN="' + 'a'.repeat(n)],
      ['basic scheme with no value', (n) => 'authorization: basic '.repeat(n / 21)],
      // Round 16.
      ['"eyJ" end to end (JWT)', (n) => 'eyJ'.repeat(n / 3)],
      ['"sk-" end to end', (n) => 'sk-'.repeat(n / 3)],
      ['many curls, each with -u and no user:pass', (n) => 'curl -u '.repeat(n / 8)],
      ['camelCase key names end to end', (n) => 'storageKey='.repeat(n / 11)],
      ['a key name then an endless value', (n) => 'storageKey=' + 'aB3+'.repeat(n / 4)],
    ];

    for (const [name, build] of shapes) {
      it(name, () => {
        millis(build(2_000)); // warm the JIT so the first call is not the measured one
        // Best of three: the suite runs files in parallel, and one descheduled
        // run is a scheduler fact, not a property of the pattern.
        const best = (n: number) => Math.min(millis(build(n)), millis(build(n)), millis(build(n)));
        const small = Math.max(best(20_000), 0.5);
        const large = best(200_000);
        // Ratios, not milliseconds: CI runners are noisy and the property is the
        // SHAPE of the curve. Linear is ~10x, quadratic ~100x.
        //
        // The ratio only means something once the large run is slow enough to
        // measure. A shape that redacts 200 KB in a few milliseconds has a small
        // sample under the 0.5ms floor, and then the ratio is scheduler noise:
        // under a parallel suite this failed at 16ms / 0.5ms = 32 on a pattern
        // that is nowhere near quadratic (the quadratic version took 31 SECONDS
        // at this size). Below 50ms the absolute bound is the whole check.
        if (large > 50) {
          expect(large / small, `${small.toFixed(1)}ms -> ${large.toFixed(1)}ms`).toBeLessThan(30);
        }
        expect(large).toBeLessThan(2000);
      });
    }
  });

  // DeerDawn's own credentials, in the shapes apps/api mints: an API key (and an
  // OAuth access token) is dd_<8 hex>_<64 hex> (utils/security.js), a refresh
  // token ddr_<64 hex> (routes/oauth.js). Bare, in prose, the pass that catches
  // `KEY=value` never sees them.
  describe('DeerDawn credentials', () => {
    const apiKey = 'dd_' + 'a1b2c3d4' + '_' + '0f'.repeat(32);
    const refresh = 'ddr_' + '9e'.repeat(32);

    it('masks a bare API key and refresh token in prose', () => {
      const out = expectGone(`my key is ${apiKey}, refresh ${refresh}.`, apiKey, refresh, '0f0f0f0f', '9e9e9e9e');
      expect(out).toBe(`my key is ${R}, refresh ${R}.`);
    });

    it('masks one inside JSON and a URL query', () => {
      expectGone(`{"key":"${apiKey}"}`, apiKey);
      expectGone(`https://example.com/x?t=${refresh}&y=1`, refresh);
    });

    it('leaves identifiers that merely start with dd_ alone', () => {
      for (const text of ['dd_trace_id', 'call add_dd_hook', 'dd_' + 'a1b2c3d4' + '_short', 'odd_' + 'a1b2c3d4' + '_' + '0f'.repeat(32)]) {
        expect(redactSecrets(text)).toBe(text);
      }
    });
  });
});
