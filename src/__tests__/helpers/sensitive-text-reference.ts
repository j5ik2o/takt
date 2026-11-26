// Reference: a character scanner for URL userinfo and unquoted assignments (#165). It is written
// from the description of the two forms, not from the patterns in sensitive-text.ts. It stands for
// the new reading only; the previous implementation's ranges are added to it in the property.

const isKeyChar = (char: string | undefined): boolean => char !== undefined && /^[A-Za-z0-9_.-]$/.test(char);
const isSpace = (char: string | undefined): boolean => char === ' ' || char === '\n' || char === '\t' || char === '\r';
const KEY_WORDS = ['apikey', 'api_key', 'api-key', 'token', 'password', 'secret'];
const endsUserOrPasswordHead = (char: string | undefined): boolean => char === undefined || '/?#@'.includes(char) || isSpace(char);
const endsTail = (char: string | undefined): boolean => char === undefined || '/?#"\'`<>()[]{}'.includes(char) || isSpace(char);
const endsAssignedValue = (char: string | undefined): boolean => char === undefined || '"\'[{,}]'.includes(char) || isSpace(char);

/**
 * The last `@` at or after `from` before the tail ends, or -1. The tail starts right after an `@`.
 * A `,` ends it only after a letter or digit (of any script) since the latest `@`, which could be
 * a host (#175): `@host,admin@example.test` ends at the `,`, `@,secret@host` does not. Once a `,`
 * was passed, later ones up to the next `@` do not end it either (`@,a,b@host`, R175-1).
 */
function lastAtInTail(text: string, from: number): number {
  let last = -1;
  let hostChar = false;
  let passedComma = false;
  for (let index = from; !endsTail(text[index]); index++) {
    const char = text[index]!;
    if (char === '@') {
      last = index;
      hostChar = false;
      passedComma = false;
    } else if (char === ',') {
      if (hostChar && !passedComma) break;
      passedComma = true;
    } else if (/^[\p{L}\p{N}]$/u.test(char)) {
      hostChar = true;
    }
  }
  return last;
}

function referenceUserinfos(text: string): Array<{ start: number; end: number }> {
  const userinfos: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < text.length) {
    if (!text.startsWith('://', index) || !/[A-Za-z]/.test(text[index - 1] ?? '')) {
      index += 1;
      continue;
    }
    const start = index + 3;
    let cursor = start;
    while (!endsUserOrPasswordHead(text[cursor]) && text[cursor] !== ':') cursor += 1;
    if (text[cursor] !== ':') {
      index += 1;
      continue;
    }
    const passwordStart = cursor + 1;
    let end = -1;
    // One leading `@` belongs to the password; the head after it runs up to the next `@`.
    const headStart = text[passwordStart] === '@' ? passwordStart + 1 : passwordStart;
    if (headStart > passwordStart && text[headStart] === '@') {
      const later = lastAtInTail(text, headStart + 1);
      end = later >= 0 ? later : headStart;
    } else {
      cursor = headStart;
      while (!endsUserOrPasswordHead(text[cursor])) cursor += 1;
      if (cursor > headStart && text[cursor] === '@') {
        const later = lastAtInTail(text, cursor + 1);
        end = later >= 0 ? later : cursor;
      }
    }
    if (end < 0) {
      index += 1;
      continue;
    }
    let schemeStart = index;
    while (/[A-Za-z0-9+.-]/.test(text[schemeStart - 1] ?? '')) schemeStart -= 1;
    const quote = text[schemeStart - 1];
    const head = text.slice(start, text.indexOf('@', start));
    let crossesItem = false;
    for (let at = 0; at < head.length && (quote === '"' || quote === "'"); at++) {
      if (head[at] !== quote) continue;
      let next = at + 1;
      while (isSpace(head[next])) next += 1;
      if (head[next] !== ',') continue;
      next += 1;
      while (isSpace(head[next])) next += 1;
      if (head[next] === quote) crossesItem = true;
    }
    if (!crossesItem) userinfos.push({ start, end });
    index = end + 1;
  }
  return userinfos;
}

function referenceAssignments(text: string, userinfoStarts: ReadonlySet<number>): Array<{ start: number; end: number }> {
  const values: Array<{ start: number; end: number }> = [];
  for (let keyStart = 0; keyStart < text.length; keyStart++) {
    if (!isKeyChar(text[keyStart]) || isKeyChar(text[keyStart - 1])) continue;
    let keyEnd = keyStart;
    while (isKeyChar(text[keyEnd])) keyEnd += 1;
    const key = text.slice(keyStart, keyEnd).toLowerCase();
    if (!KEY_WORDS.some((word) => key.includes(word)) || userinfoStarts.has(keyStart)) continue;
    let cursor = keyEnd;
    while (isSpace(text[cursor])) cursor += 1;
    if (text[cursor] !== ':' && text[cursor] !== '=') continue;
    cursor += 1;
    while (isSpace(text[cursor])) cursor += 1;
    const start = cursor;
    while (!endsAssignedValue(text[cursor])) cursor += 1;
    if (cursor > start) values.push({ start, end: cursor });
  }
  return values;
}

/** What the reference scanner hides: URL userinfo and unquoted assignments, on the original text. */
export function referenceRanges(text: string): Array<{ start: number; end: number }> {
  const userinfos = referenceUserinfos(text);
  return [...userinfos, ...referenceAssignments(text, new Set(userinfos.map((userinfo) => userinfo.start)))];
}
