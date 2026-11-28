#!/usr/bin/env node
// #151 2a (design 13th edition, R12-4): the tests that must catch each deliberately broken stream do
// catch it. Each mutant edits src/shared/utils/sensitive-stream.ts, runs the tests named for it, and
// restores the file. Run it from the repository root after the implementation is in:
//
//   node src/__tests__/sensitive-stream-union.mutants.mjs
//
// Exit 0: every mutant is caught. 1: a mutant survives. 2: an anchor is missing (the implementation
// moved; update the anchor, not the tests). 3: the tests fail before any mutant.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/shared/utils/sensitive-stream.ts';
const UNION = 'src/__tests__/sensitive-stream-union.pbt.test.ts';
const FIXED = 'src/__tests__/sensitive-text-fixed-examples.test.ts';

const MUTANTS = [
  {
    name: 'commitNoLegacy',
    why: 'the commit of a held run applies neither the units\' previous ranges (s1) nor their trace (s2)',
    within: 'private commitHeld(',
    edits: [
      [/^[^\n]*for \(const range of unit\.legacyRanges\)[^\n]*\n/m, ''],
      [/^[^\n]*for \(const range of [^\n]*displayTraceRanges\(unit\)[^\n]*\n/m, ''],
    ],
    // Marker for marker, (s3) covers (s1) and (s2) on almost every input, so the display properties
    // seldom see this mutant; the buffer stage compares hidden positions, and fixed example #3
    // (`Zq0Zq`, hidden by (s2) only) runs through both displays.
    tests: [[UNION, 'buffer stage'], [FIXED, 'ToolActivityDisplay']],
  },
  {
    name: 'previewNoLegacy',
    why: 'the preview applies neither the inner tail\'s previous ranges (legacyMerged) nor its trace',
    within: 'private previewRanges(',
    edits: [
      [/^[^\n]*for \(const range of legacyMerged\)[^\n]*\n/m, ''],
      [/previousDisplayRanges\(innerText,/g, '((..._unused) => [])(innerText,'],
    ],
    tests: [[UNION, 'ToolActivityDisplay']],
  },
  {
    name: 'capCutAtHeldEnd',
    why: 'at the cap the held run is cut at its end, through an open new value (R12-1)',
    within: undefined,
    edits: [[/this\.closedHeldUnitCount\(\)/g, '0']],
    tests: [[UNION, 'R12-1']],
  },
];

function run(file, pattern) {
  const result = spawnSync('npx', ['vitest', 'run', file, '-t', pattern], { stdio: 'pipe', encoding: 'utf8' });
  return result.status === 0;
}

function mutate(source, mutant) {
  const start = mutant.within === undefined ? 0 : source.indexOf(mutant.within);
  if (start < 0) throw new Error(`${mutant.name}: anchor ${mutant.within} not found`);
  const next = source.indexOf('\n  private ', start + 1);
  const end = mutant.within === undefined || next < 0 ? source.length : next;
  let body = source.slice(start, end);
  for (const [pattern, replacement] of mutant.edits) {
    if (!pattern.test(body)) throw new Error(`${mutant.name}: anchor ${pattern} not found`);
    pattern.lastIndex = 0;
    body = body.replace(pattern, replacement);
  }
  return source.slice(0, start) + body + source.slice(end);
}

const original = readFileSync(FILE, 'utf8');
for (const [file, pattern] of [...new Set(MUTANTS.flatMap((mutant) => mutant.tests.map((test) => test.join('\0'))))]
  .map((test) => test.split('\0'))) {
  if (!run(file, pattern)) {
    console.error(`the tests fail without a mutant: ${file} -t ${JSON.stringify(pattern)}`);
    process.exit(3);
  }
}
let survived = 0;
for (const mutant of MUTANTS) {
  let mutated;
  try {
    mutated = mutate(original, mutant);
  } catch (error) {
    console.error(String(error));
    process.exit(2);
  }
  try {
    writeFileSync(FILE, mutated);
    for (const [file, pattern] of mutant.tests) {
      const caught = !run(file, pattern);
      console.log(`${caught ? 'caught  ' : 'SURVIVED'} ${mutant.name} (${mutant.why}) by ${file} -t ${JSON.stringify(pattern)}`);
      if (!caught) survived += 1;
    }
  } finally {
    writeFileSync(FILE, original);
  }
}
process.exit(survived === 0 ? 0 : 1);
