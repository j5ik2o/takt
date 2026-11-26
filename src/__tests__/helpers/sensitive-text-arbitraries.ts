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

/**
 * Inputs written down in design section 3, character for character (FINDING5-REREAD.md 2.1, 2.2,
 * 2.4, and the review forms). Each marker is a secret.
 */
export const LEAK_FORMS: readonly string[] = [
  // FINDING5-REREAD.md 2.1
  'https://token:p@host;-u-uég97q:lgsn=Zq84Zq/ Set-Cookie: Zq85Zq',
  'https://token:p@host;-ualice:Zq100Zq',
  'https://token:p@host;https://token:p@host;https://token:p@host;-u<36zss7aa2f9p:n630tm1zvas7;g871v1lZq598Zq9uqk[\r\n',
  // FINDING5-REREAD.md 2.1, supplement: seed 2 idx=10876 and seed 5 idx=9300 (the parts it quotes).
  "https://token:p@host;https://token:p@host;https://token:p@host;sk-Zq586Zqabcdefgh&x1://u:@lh691🔑8870v5aZq727Zq(?rs527r0@host'[",
  'https://token:p@host;cookie=q5se;Zq319Zqg20v0gg161v3h=#\r\n',
  // FINDING5-REREAD.md 2.4
  'https://token:p@host-uuser:Zq101Zq',
  'https://token:p@host:user:Zq102Zq',
  'https://token:p@host:8080:lgsn=Zq103Zq',
  'https://token:p@host=Zq105Zq',
  'https://cookie:p@host:lgsn=Zq106Zq',
  'https://token:p@host.:8443:user:Zq108Zq',
  'https://TOKEN:p@HOST-uuser:Zq110Zq',
  'https://COOKIE:p@HOST:u:Zq111Zq',
  'https://token:Zq130Zq@host-uuser:Zq130Zq',
  'https://token:p@host\u001b:Zq113Zq',
  'https://token:p@host&-uuser:Zq121Zq',
  'https://token:p@host|-uuser:Zq122Zq',
  'https://token:p@host;-uuser:Zq123Zq',
  'https://token:p@host-uuser:Zq12345Zq',
  'https://token:p@host.Zq1Zq',
  // FINDING5-REREAD.md 2.2 / 3.1 (L1 and its variants)
  'https://cookie:a@host Cookie: Zq24Zq',
  'https://Authorization:a@h Authorization: Bearer Zq25Zq9',
  'https://proxy-authorization:a@h Authorization: Basic Zq32Zq',
  'https://set-cookie:a@h Set-Cookie: s=Zq26Zq',
  'https://cookie:a@host\nCookie: Zq33Zq',
  'https://my-cookie:a@host Cookie: Zq27Zq',
  'https://u:Cookie:p@h Cookie: Zq28Zq',
  'https://authorization:a@host Authorization: Zq29Zq',
  'https://COOKIE:a@host Cookie: Zq30Zq',
  // Leak 2 (#165) and its L2 variants
  "TOKEN=apikey: ?token=' 'Zq4Zq",
  'token:token :--password=\\" \\"Zq0Zq',
  // Review forms (#160, #165)
  'https://u:p@host;TOKEN=left@Zq902Zq',
  'TOKEN=Zq903Zq;echo done',
  'http://a:@Zq904Zq@host;ops@example.test',
  'credentials="note token=Zq905Zq end"',
  '["https://localhost:Zq906Zq","ops@example.test"]',
  'clone https://token:Zq907Zq@host/repo.git failed',
  'clone https://cookie:Zq908Zq@host/repo.git failed',
  'clone https://password:Zq909Zq@host/repo.git failed',
  'clone https://session_id:Zq910Zq@host/repo.git failed',
  'clone https://api_key:Zq911Zq@host/repo.git failed',
  'token=https://user:Zq912Zq@example.test/path?x=1',
];

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
  // Forms from design section 3 (#151): keys as URL users or passwords followed by a real header,
  // keys inside a value, near-empty quoted values, zero-width replacements.
  fc.tuple(fc.constantFrom('cookie', 'authorization', 'set-cookie', 'COOKIE', 'my-cookie', 'proxy-authorization'), awkwardSecret, fc.constantFrom(' ', '\n', ';', ',', ''))
    .map(([user, value, join]) => `https://${user}:a@host${join}Cookie: ${value}`),
  fc.tuple(fc.constantFrom('cookie:', 'authorization:', 'token=', 'password=', 'session_id:', 'api_key=', 'Cookie:'), awkwardSecret, fc.constantFrom(' ', '\n', ';', ','))
    .map(([key, value, join]) => `https://u:${key}p@h${join}${key.replace(/[:=]$/, '')}=${value}`),
  awkwardSecret.map((value) => `https://Authorization:a@h Authorization: Bearer ${value}`),
  awkwardSecret.map((value) => `https://proxy-authorization:a@h Authorization: Basic ${value}`),
  awkwardSecret.map((value) => `https://u:Cookie:p@h Cookie: ${value}`),
  fc.tuple(fc.constantFrom('apikey: ', 'TOKEN\t=', 'token :', 'token: '), fc.constantFrom("?token=' '", '--password=\\" \\"', '&password=" "', '?token=', 'Cookie: ', 'Bearer '), awkwardSecret)
    .map(([key, inner, value]) => `TOKEN=${key}${inner}${value}`),
  fc.tuple(fc.constantFrom('token=""', "token=''", 'token=\\"\\"', 'Authorization: Bearer '), fc.constantFrom('--password=', '?token=', 'session_id:', 'token=', 'Cookie: '), awkwardSecret)
    .map(([empty, next, value]) => `${empty}${next}${value}`),
  fc.tuple(fc.constantFrom('-u', '-uuser:', ':user:', ':8080:lgsn=', '=', '.:8443:user:', '&-uuser:', '|-uuser:', ';-uuser:', '\u001b:', '.'), awkwardSecret)
    .map(([glue, value]) => `https://token:p@host${glue}${value}`),
  fc.tuple(awkwardSecret, awkwardSecret).map(([first, second]) => `https://token:p@host;sk-${first}abcdefgh&x1://u:@lh691${second}(?rs527r0@host'[`),
  awkwardSecret.map((value) => `https://token:p@host;cookie=q5se;${value}g20v0gg161v3h=#\r\n`),
  fc.constantFrom(...LEAK_FORMS),
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
  // A header name as the URL user (or inside the password) and then the real header (design 3, L).
  fc.tuple(fc.constantFrom('cookie', 'COOKIE', 'my-cookie', 'set-cookie', 'u:Cookie'), knownSecret.filter((value) => !/[;,]/.test(value)))
    .map(([user, value]) => ({ text: `https://${user}:a@host Cookie: ${value}`, echoes: [value] })),
  fc.tuple(fc.constantFrom('Authorization', 'authorization', 'proxy-authorization'), fc.constantFrom('Bearer', 'Basic'), knownSecret.filter((value) => !/[;,]/.test(value)))
    .map(([user, scheme, value]) => ({ text: `https://${user}:a@h Authorization: ${scheme} ${value}`, echoes: [value] })),
);

/** Lines without any credential that no path changes, including forms that look close to one. */
export const PLAIN_FORMS: readonly string[] = [
  'ops@example.test', 'admin@example.test, ops@example.test', 'https://host:443/path', 'https://example.test/a?b=c',
  "['https://:80', 'x@y.test']", 'Bearer authentication is required', 'see --user for details', 'curl --help', '@@@@ @',
  'key = 3', 'tokens are counted', 'git clone https://example.test/repo.git', 'mailto:ops@example.test', 'é 日本 🔑', 'a\u001bb',
];

const PLAIN_WORDS = ['build', 'failed', 'ok', 'name=value', 'user:', 'note', 'path/to', 'a,b', '(x)', '{y}', '[z]'];

/**
 * Known over-masking (design 3, K; PR body "known behavior"). Each form, alone on a line, becomes
 * the given output. Changing this set changes what is hidden too much: raise it with the marshal.
 */
export const OVERMASK_FORMS: ReadonlyArray<readonly [input: string, output: string]> = [
  ['["https://localhost:443","ops@example.test"]', '["https://[REDACTED]@example.test"]'],
  ['["https://:443","ops@example.test"]', '["https://[REDACTED]@example.test"]'],
  ['curl -u\nuser:', 'curl -u\n[REDACTED]'],
  ['curl -u\nmailto:ops@example.test', 'curl -u\n[REDACTED]'],
  ['curl -u\nhttps://host:443/path', 'curl -u\n[REDACTED]'],
  ['clone https://token:x@host/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://token:Zq24Zq@host/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://password:Zq24Zq@host/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://session_id:Zq24Zq@host/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://api_key:Zq24Zq@host/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://cookie:Zq24Zq@host/repo.git failed', 'clone https://[REDACTED]'],
  ['clone https://authorization:Zq24Zq@host/repo.git failed', 'clone https://[REDACTED]'],
  ['clone https://u:token=Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://u:token:Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://u:session_id:Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://u:cookie=Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED] failed'],
  ['clone https://my-cookie:Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED]'],
  ['clone https://proxy-authorization:Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED]'],
  ['clone https://set-cookie:Zq24Zq@host/repo.git failed', 'clone https://[REDACTED]'],
  ['clone https://u:cookie:Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED]'],
  ['clone https://u:Cookie:Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED]'],
  ['clone https://u:password=Zq24Zq@github.com/org/repo.git failed', 'clone https://[REDACTED] failed'],
];

/** A form that ends with `curl -u`: the next line's first word is read as its value (design 3, K). */
export const CURL_USER_AT_LINE_END = 'curl -u';

/** The next line after `curl -u`, as every path prints it: a first word holding `:` is hidden. */
export function afterCurlUserAtLineEnd(line: string): string {
  // curl's bare value: the first character is not a quote or `+`, a `:` comes before whitespace.
  return line.replace(/^(?![+"']|\\")[^\s:]*:\S*/u, '[REDACTED]');
}

/** Lines of text without any credential, including forms that look close to one. */
export const plainLine: fc.Arbitrary<string> = fc.oneof(
  fc.array(fc.constantFrom(...PLAIN_WORDS), { minLength: 1, maxLength: 4 }).map((words) => words.join(' ')),
  fc.constantFrom(...PLAIN_FORMS),
);

/** A line around a credential: plain, or a known over-masked form (design 3, L). */
export const contextLine: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: plainLine },
  { weight: 1, arbitrary: fc.constantFrom(...OVERMASK_FORMS.map(([input]) => input)) },
);

export const plainText: fc.Arbitrary<string> = fc.array(fc.tuple(plainLine, fc.constantFrom('\n', ' ', ' | ', '; ')), { minLength: 1, maxLength: 5 })
  .map((parts) => parts.map(([line, join]) => line + join).join(''));

/** Lines that each hold one credential or none, so what lies outside a credential is known. */
export const lineDocument = fc.array(
  fc.oneof(credentialFragment.map((fragment) => ({ ...fragment, plain: false })), plainLine.map((text) => ({ text, echoes: [] as string[], plain: true }))),
  { minLength: 1, maxLength: 6 },
);

/** Like lineDocument, with known over-masked forms as context lines too (design 3, L). */
export const contextDocument = fc.array(
  fc.oneof(credentialFragment.map((fragment) => ({ ...fragment, plain: false })), contextLine.map((text) => ({ text, echoes: [] as string[], plain: true }))),
  { minLength: 1, maxLength: 6 },
);

/**
 * Inputs where two steps of the previous display collide (design 10, N4): a later step's prefix
 * right after an earlier step's value, so swapping two steps changes the output.
 */
export const stageCollisionText: fc.Arbitrary<string> = fc
  .array(
    fc.tuple(
      fc.oneof(
        fc.tuple(awkwardSecret, awkwardSecret).map(([a, b]) => `Bearer ${a}x1234567 Authorization: Basic ${b}`),
        awkwardSecret.map((value) => `Authorization: x --user=a:${value}`),
        awkwardSecret.map((value) => `Cookie: a --user=a:${value}`),
        fc.tuple(awkwardSecret, sensitiveKey).map(([value, key]) => `session_id: a${key}=${value}`),
        fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `${key}=a--password=${value}`),
        fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `${key}=a?token=${value}`),
        fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `--user=a:b${key}=${value}`),
        fc.tuple(fc.constantFrom('token=""', "token=''", 'token=\\"\\"', 'Authorization: Bearer '), fc.constantFrom('--password=', '?token=', 'session_id:', 'token=', 'Cookie: ', '-uu:', 'https://u:'), awkwardSecret)
          .map(([empty, next, value]) => `${empty}${next}${value}`),
        fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `${key}: "a" Bearer ${value}abcdefgh1`),
        fc.tuple(awkwardSecret, awkwardSecret).map(([a, b]) => `https://u:${a}@h?token=${b}`),
        fc.tuple(sensitiveKey, awkwardSecret).map(([key, value]) => `cookie=${key}:${value}`),
        fc.tuple(awkwardSecret, sensitiveKey).map(([value, key]) => `-----BEGIN PRIVATE KEY-----\n${key}="${value}"\n-----END PRIVATE KEY-----`),
        chaosFragment,
      ),
      joiner,
    ),
    { minLength: 1, maxLength: 4 },
  )
  .map((parts) => parts.map(([part, join]) => part + join).join(''));

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

/**
 * The core of leak 2 (design 3, finding 8 (1)): a key followed by a space before its separator,
 * and a near-empty quoted value right before the secret. Weighted to at least a tenth of the
 * leak generator, not one in twenty thousand.
 */
export const l2CoreText: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('apikey: ', 'TOKEN\t=', 'token :', 'token:token :', 'password :', 'TOKEN=apikey: '),
    fc.constantFrom("?token=' '", '--password=\\" \\"', '&password=" "', '?token=""', "--password=''"),
    awkwardSecret,
    fc.constantFrom('', ' ', '\n', ';'),
  )
  .map(([key, near, value, tail]) => key + near + value + tail);

/** Every leak form at once: chaos, the written-down forms glued to chaos, and the L2 core. */
export const leakText: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: chaosText },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom(...REVIEW_FORMS, ...LEAK_FORMS), chaosText).map(([form, rest]) => form + rest) },
  { weight: 1, arbitrary: fc.tuple(chaosText, fc.constantFrom(...REVIEW_FORMS, ...LEAK_FORMS)).map(([rest, form]) => rest + '\n' + form) },
  { weight: 1, arbitrary: fc.tuple(l2CoreText, fc.oneof(fc.constant(''), chaosText)).map(([core, rest]) => core + rest) },
);

const PREFERRED_CUT = /[\n@]|(?<=[a-z])(?=[a-z]*[:=])/gu;

/** Cuts `text` into 1 to 4 chunks, preferring cuts at a newline, before `@` and inside a key. */
export function chunksOf(text: string): fc.Arbitrary<string[]> {
  const preferred = [...text.matchAll(PREFERRED_CUT)].map((match) => match.index);
  const cut = fc.oneof(
    { weight: 2, arbitrary: preferred.length === 0 ? fc.nat(text.length) : fc.constantFrom(...preferred).chain((at) => fc.constantFrom(at, at + 1)) },
    { weight: 1, arbitrary: fc.nat(text.length) },
  );
  return fc.array(cut, { maxLength: 3 }).map((cuts) => {
    const points = [...new Set(cuts.map((at) => Math.min(at, text.length)))].sort((a, b) => a - b);
    const chunks: string[] = [];
    let from = 0;
    for (const point of points) {
      chunks.push(text.slice(from, point));
      from = point;
    }
    chunks.push(text.slice(from));
    return chunks;
  });
}
