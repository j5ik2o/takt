import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The frozen copies of the previous redaction (#151, docs/design/sensitive-text-legacy-copy.md).
// A change to one of them changes what "hidden before" means for every property test. Change a
// hash only with the reason and the design review named in the commit body.
const FROZEN: ReadonlyArray<readonly [path: string, sha256: string]> = [
  ['src/shared/utils/sensitive-text-legacy.ts', '1b9fb74528d9a9b53d750a853bc25ee30263ef493bb9360abce15afcf5dc96b0'],
  ['src/__tests__/helpers/legacy-sensitive-text.ts', 'f60b021489ac4a8804f5e3329188ef95f258fb21c166969817498264ce1ded25'],
  ['src/__tests__/helpers/legacy-sensitive-value.ts', '185a9d7b6198f0d2ab1c05ea1a0a1b5cbeeb437ef702334a2065c1eb274462a5'],
  ['src/__tests__/helpers/legacy-sensitive-stream.ts', 'f3f4e81c2115af9ea759b68f97388a21f0d95e125279bb5be302994bcf1f0449'],
  ['src/__tests__/helpers/legacy-phase1-execution-log.ts', '7800d5d397d59301b397646d8689cf544179acfd6b0ba3a6848324154c7c8cba'],
];

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('frozen copies of the previous redaction', () => {
  it.each(FROZEN.map(([path, sha256]) => [path, sha256] as const))('%s is unchanged', (path, sha256) => {
    const text = readFileSync(ROOT + path, 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(text).digest('hex')).toBe(sha256);
  });
});
