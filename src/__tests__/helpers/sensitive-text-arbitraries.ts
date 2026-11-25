import fc from 'fast-check';

/**
 * Generators for the redaction property tests. Every secret that must stay hidden carries a
 * marker (`Zq<n>Zq`), so a test can tell a leaked secret from a readable host or word.
 */

export interface Fragment {
  readonly text: string;
  /** Values a later output may print on their own; tracking must hide each of them. */
  readonly echoes: readonly string[];
}

export const MARKER_REGEX = /Zq\d+Zq/g;

export function markersIn(text: string): string[] {
  return [...new Set(text.match(MARKER_REGEX) ?? [])];
}

const marker = fc.integer({ min: 0, max: 899 }).map((id) => `Zq${id}Zq`);

/** Characters that end, open or escape something in one of the credential forms. */
const DELIMITERS = [',', '(', ')', "'", '"', '`', '<', '>', '[', ']', '{', '}', ';', '&', '|', '@', ':', '=', '\\', '/', '?', '#'];
const AWKWARD = ['\n', '\r\n', '\t', ' ', '\\"', '\u0000', '\u001b', '\u2028', 'é', '日本', '🔑', '@@', '@@@@@@@@', '--', '-u', '+'];

const filler = fc.stringMatching(/^[a-z0-9]{0,6}$/);
const awkwardChar = fc.constantFrom(...DELIMITERS, ...AWKWARD);
const awkwardText = fc.array(fc.oneof(filler, awkwardChar), { maxLength: 6 }).map((parts) => parts.join(''));

/** A secret value with a marker and arbitrary delimiters around it. */
const awkwardSecret = fc.tuple(awkwardText, marker, awkwardText).map(([head, mark, tail]) => head + mark + tail);
const longSecret = fc.tuple(marker, fc.integer({ min: 257, max: 600 }), fc.constantFrom('a', 'a@', '@', 'a;', 'x,'))
  .map(([mark, length, unit]) => mark + unit.repeat(Math.ceil(length / unit.length)) + mark.replace(/^Zq/, 'Zq1'));

const sensitiveKey = fc.constantFrom(
  'token', 'TOKEN', 'password', 'PASSWORD', 'api_key', 'apiKey', 'secret', 'credentials', 'access_token',
  'GITHUB_TOKEN', 'x-api-key', 'db.password', 'private_key', 'refresh-token',
);
const keySeparator = fc.constantFrom('=', ':', ' = ', ': ', ':\n', '=\n', ':\t');

const scheme = fc.constantFrom('https', 'http', 'redis', 'postgres', 'git+ssh', 'x1');
const hostPart = fc.constantFrom('host', 'db.internal', 'example.test/path', 'h:5432/db', 'host/repo.git');

/** Anything: the differential test takes these apart and puts them back together at random. */
const chaosFragment: fc.Arbitrary<string> = fc.oneof(
  // URL userinfo with delimiters in the user or the password head.
  fc.tuple(scheme, awkwardText, awkwardSecret, hostPart).map(([s, user, password, host]) => `${s}://${user}:${password}@${host}`),
  fc.tuple(scheme, awkwardSecret, hostPart).map(([s, password, host]) => `${s}://:${password}@${host}`),
  fc.tuple(scheme, awkwardSecret).map(([s, password]) => `${s}://u:@${password}@host`),
  fc.tuple(scheme, longSecret).map(([s, password]) => `${s}://u:${password}@host`),
  fc.tuple(sensitiveKey, keySeparator, awkwardSecret).map(([key, separator, value]) => key + separator + value),
  fc.tuple(sensitiveKey, keySeparator, longSecret).map(([key, separator, value]) => key + separator + value),
  fc.tuple(sensitiveKey, fc.constantFrom('"', "'", '\\"'), awkwardSecret).map(([key, quote, value]) => `${key}=${quote}${value}${quote}`),
  fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `\\"${key}\\":\\"${value}\\"`),
  fc.tuple(sensitiveKey, sensitiveKey, awkwardSecret).map(([outer, inner, value]) => `${outer}="note ${inner}='${value}' end"`),
  fc.tuple(sensitiveKey, sensitiveKey, awkwardSecret).map(([outer, inner, value]) => `${outer}="a ${inner}=\\"${value}\\" b"`),
  awkwardSecret.map((value) => `Authorization: Bearer ${value}`),
  awkwardSecret.map((value) => `Authorization: Basic ${value}`),
  fc.tuple(awkwardSecret, awkwardText).map(([value, rest]) => `Cookie: sid=${value}; ${rest}`),
  awkwardSecret.map((value) => `Set-Cookie: session=${value}; Path=/`),
  awkwardSecret.map((value) => `session_id: ${value}`),
  awkwardSecret.map((value) => `cookie=${value}`),
  fc.tuple(awkwardText, awkwardSecret).map(([user, password]) => `curl -u ${user}:${password}`),
  fc.tuple(awkwardText, awkwardSecret).map(([user, password]) => `--user=${user}:${password}`),
  fc.tuple(awkwardText, awkwardSecret).map(([user, password]) => `-u${user}:${password}`),
  fc.tuple(awkwardText, awkwardSecret).map(([user, password]) => `--user="${user}:${password}"`),
  fc.tuple(awkwardText, awkwardSecret).map(([user, password]) => `--user=\\"${user}:${password}\\"`),
  awkwardSecret.map((value) => `-u a:b--password --password ${value}`),
  fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `--${key} ${value}`),
  fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `--${key}="${value}"`),
  awkwardSecret.map((value) => `https://example.test/p?token=${value}&x=1`),
  marker.map((mark) => `Bearer ${mark}abcdefgh12`),
  marker.map((mark) => `sk-${mark}abcdefgh`),
  marker.map((mark) => `ghp_${mark}abcdefgh`),
  marker.map((mark) => `-----BEGIN PRIVATE KEY-----\n${mark}\n-----END PRIVATE KEY-----`),
  // Shell statements glued to a value, and long runs of them.
  fc.tuple(sensitiveKey, marker, fc.constantFrom(';', '&', '|', '&&', ';echo '), awkwardText)
    .map(([key, mark, separator, rest]) => `${key}=${mark}${separator}${rest}`),
  fc.tuple(sensitiveKey, marker, fc.integer({ min: 1, max: 40 })).map(([key, mark, count]) => `${key}=${mark}${';a'.repeat(count)}`),
  // Text without credentials, including forms that almost are one.
  fc.constantFrom(
    'ops@example.test', '["https://:443","ops@example.test"]', '["https://localhost:443","ops@example.test"]',
    'https://host:443/path', '@', '@@@@', 'name=value', 'Bearer authentication', 'curl -u', '--user=alice',
    'token', 'password:', 'Cookie:', 'Authorization:', '"', "'", '\\"', '://', 'x://', 'a=b',
  ),
  filler,
  awkwardText,
);

const joiner = fc.constantFrom('', ' ', '\n', '\r\n', ';', '&', '|', ',', '","', "', '", '"', "'", '\\"', '\t', ': ', '=', '@');

/** Fragments glued with delimiters, so one form's value can run into the next form's key. */
export const chaosText: fc.Arbitrary<string> = fc
  .array(fc.tuple(fc.constantFrom('', '"', "'", '['), chaosFragment, joiner), { minLength: 1, maxLength: 5 })
  .map((parts) => parts.map(([open, fragment, join]) => open + fragment + join).join(''));

/** The forms from the review of #160 and #161 and the five inputs of #151, with markers. */
export const REVIEW_FORMS: readonly string[] = [
  'https://user:pa,Zq900Zq@host',
  '["https://localhost:443","ops@example.test"]',
  '["https://:443","ops@example.test"]',
  'clone https://token:Zq901Zq@host/repo.git failed',
  'https://u:p@host;--user=alice;--user=alice;--user=alice',
  'https://u:p@host;TOKEN=left@Zq902Zq',
  'TOKEN=Zq903Zq;echo done',
  'http://a:@Zq904Zq@host;ops@example.test',
  'credentials="note token=Zq905Zq end"',
  'Bearer Zq906Zqabcdefgh12345',
  'https://u:p@token=@Zq907Zq/path',
  'token=https://user:Zq908Zq@example.test/path?x=1',
  'CREDENTIALS="https://alice:Zq909Zq@host"',
  'https://token:p@host;https://token:p@host;https://token:p@host;',
  'TOKEN="https://user:Zq910Zq@host"',
  'Cookie: a=b; token:\npassword: Zq911Zq',
  'curl -u a:b--password --password Zq912Zq',
];

/** Credential forms whose secret is well formed for the form; each must be hidden. */
// A tail ending in `-u` would start a curl user option that reads the next line.
const knownSecret = fc.tuple(fc.stringMatching(/^[A-Za-z0-9]{0,4}$/), marker, fc.stringMatching(/^[A-Za-z0-9._@,;~-]{0,6}$/))
  .map(([head, mark, tail]) => head + mark + tail)
  .filter((secret) => !/-u$/i.test(secret));
const bareSecret = fc.tuple(marker, fc.stringMatching(/^[A-Za-z0-9._@:;&|/=-]{0,8}$/)).map(([mark, tail]) => mark + tail);

export const credentialFragment: fc.Arbitrary<Fragment> = fc.oneof(
  fc.tuple(scheme, fc.stringMatching(/^[a-z0-9,'"(){}<>[\]-]{0,5}$/), knownSecret, hostPart)
    .map(([s, user, password, host]) => ({ text: `${s}://${user}:${password}@${host}`, echoes: [password] })),
  fc.tuple(scheme, knownSecret).map(([s, password]) => ({ text: `${s}://u:@${password}@host`, echoes: ['@' + password] })),
  fc.tuple(scheme, longSecret).map(([s, password]) => ({ text: `${s}://u:${password}@host`, echoes: [password] })),
  fc.tuple(sensitiveKey, fc.constantFrom('=', ':', ' = ', ': '), bareSecret)
    .map(([key, separator, value]) => ({ text: key + separator + value, echoes: [value, value.split(/[;&|]/)[0]!] })),
  fc.tuple(sensitiveKey, fc.constantFrom('"', "'"), knownSecret.map((value) => value + ' x'))
    .map(([key, quote, value]) => ({ text: `${key}=${quote}${value}${quote}`, echoes: [value] })),
  fc.tuple(sensitiveKey, sensitiveKey, bareSecret.filter((value) => !/[;&|]/.test(value)))
    .map(([outer, inner, value]) => ({ text: `${outer}="note ${inner}=${value} end"`, echoes: [value] })),
  fc.tuple(sensitiveKey, knownSecret).map(([key, value]) => ({ text: `\\"${key}\\":\\"${value}\\"`, echoes: [value] })),
  // A key inside another value: `token=a;password=secret` prints `secret` on its own later.
  fc.tuple(sensitiveKey, sensitiveKey, bareSecret.filter((value) => !/[;&|]/.test(value)))
    .map(([outer, inner, value]) => ({ text: `${outer}=a;${inner}=${value}`, echoes: [value] })),
  knownSecret.map((value) => ({ text: `Authorization: Bearer ${value}`, echoes: [value] })),
  knownSecret.map((value) => ({ text: `Cookie: sid=${value}`, echoes: [value] })),
  fc.tuple(fc.stringMatching(/^[a-z]{1,5}$/), knownSecret)
    .map(([user, password]) => ({ text: `curl -u ${user}:${password} https://example.test`, echoes: [password] })),
  fc.tuple(fc.stringMatching(/^[a-z]{1,5}$/), knownSecret)
    .map(([user, password]) => ({ text: `--user=${user}:${password}`, echoes: [password] })),
  fc.tuple(sensitiveKey, knownSecret).map(([key, value]) => ({ text: `--${key.toLowerCase()} ${value}`, echoes: [value] })),
  knownSecret.filter((value) => !value.includes('&')).map((value) => ({ text: `https://example.test/p?token=${value}`, echoes: [value] })),
  marker.map((mark) => ({ text: `sk-${mark}abcdefgh`, echoes: [`sk-${mark}abcdefgh`] })),
);

/** Lines of text without any credential, including forms that look close to one. */
export const plainLine: fc.Arbitrary<string> = fc.oneof(
  fc.array(fc.constantFrom('build', 'failed', 'ok', 'name=value', 'user:', 'note', 'path/to', 'a,b', '(x)', '{y}', '[z]'), { minLength: 1, maxLength: 4 })
    .map((words) => words.join(' ')),
  fc.constantFrom(
    'ops@example.test', 'admin@example.test, ops@example.test', 'https://host:443/path', 'https://example.test/a?b=c',
    '["https://:443","ops@example.test"]', '["https://localhost:443","ops@example.test"]', "['https://:80', 'x@y.test']",
    'Bearer authentication is required', 'see --user for details', 'curl --help', '@@@@ @', 'key = 3', 'tokens are counted',
    'git clone https://example.test/repo.git', 'mailto:ops@example.test', 'é 日本 🔑', 'a\u001bb',
  ),
);

export const plainText: fc.Arbitrary<string> = fc.array(fc.tuple(plainLine, fc.constantFrom('\n', ' ', ' | ', '; ')), { minLength: 1, maxLength: 5 })
  .map((parts) => parts.map(([line, join]) => line + join).join(''));

/** Lines that each hold one credential or none, so what lies outside a credential is known. */
export const lineDocument = fc.array(
  fc.oneof(credentialFragment.map((fragment) => ({ ...fragment, plain: false })), plainLine.map((text) => ({ text, echoes: [], plain: true }))),
  { minLength: 1, maxLength: 6 },
);

/**
 * The restricted language of the reference scanner: URL userinfo and unquoted assignments,
 * with values that may contain `@`, `:`, `,` and `;`, separated by spaces, newlines and `;`.
 */
export const referenceText: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(
      fc.oneof(
        fc.tuple(fc.oneof(fc.stringMatching(/^[a-d]{0,3}$/), fc.constant('token')), fc.stringMatching(/^[a-d0-9@,:]{1,6}$/), fc.stringMatching(/^[a-d.]{1,4}$/))
          .map(([user, password, host]) => `https://${user}:${password}@${host}`),
        fc.tuple(fc.constantFrom('token', 'password', 'apikey', 'secret', 'name', 'user', 'x.token'), fc.constantFrom('=', ':', ' = ', ':\n'), fc.stringMatching(/^[a-d0-9@,:]{0,6}$/))
          .map(([key, separator, value]) => key + separator + value),
        fc.constantFrom('["https://:443","ops@example.test"]', '["https://bad:443","ops@example.test"]', 'ops@example.test', 'abc', '@', ':'),
        fc.stringMatching(/^[a-d0-9@,:]{1,6}$/),
      ),
      fc.constantFrom('', ' ', '\n', ';', ','),
    ),
    { minLength: 1, maxLength: 6 },
  )
  .map((parts) => parts.map(([part, join]) => part + join).join(''));
