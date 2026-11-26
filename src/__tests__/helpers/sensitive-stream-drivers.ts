import fc from 'fast-check';
import { ToolTurn } from '../../features/daemon/toolTurn.js';
import { classifyToolResult } from '../../shared/tool-activity/result.js';
import { RunningToolResult } from '../../shared/tool-activity/runningResult.js';
import { normalizeToolResultText, toolResultSensitiveValues } from '../../shared/tool-activity/sanitize.js';
import type { ToolActivityEntry } from '../../shared/tool-activity/types.js';
import { ToolActivityDisplay } from '../../shared/ui/ToolActivityDisplay.js';
import type { SensitiveTextStreamRedactorFactory } from '../../shared/utils/sensitive-stream.js';
import type { BoundedSensitiveValues } from '../../shared/utils/sensitive-value.js';
import * as legacyStream from './legacy-sensitive-stream.js';

// #151 2a (design 3 "stream paths, second PR"): drivers that call each stream path the way its
// callers do. Each driver runs the real component and takes the stream factory as an argument, so
// the new stream (the default) and the inner-only stream (the baseline) run through the same code.

/** One tool run on a stream path: the tool's input, its output chunks, and where a preview is read. */
export interface ToolRun {
  readonly input: Record<string, unknown>;
  readonly chunks: readonly string[];
  /** `previews[i]` reads the preview (TUI tail, running flush) after chunk `i`. */
  readonly previews: readonly boolean[];
}

/** What a stream path showed. `moments[t]` is everything shown at time `t` (committed so far and that time's preview). */
export interface StreamObservation {
  readonly committed: string;
  readonly moments: readonly string[];
  /** The stream's tracked values, where the path exposes them. */
  readonly sensitiveValues?: BoundedSensitiveValues;
  /**
   * `streamed[t]` is everything the stream returned up to time `t` for what the tool printed (every
   * write, preview and flush), with no display in between (`streamedForDisplay`): ToolActivityDisplay's
   * line cap and prefix alignment are not redaction (design 3, 12th edition).
   */
  readonly streamed?: readonly string[];
}

/**
 * What the stream returns for what the tool printed, with no display in between: the tool's output
 * so far, normalized as the display normalizes it, written to one stream of `create`, a preview read
 * where the display reads one, and a flush at the end. `streamed[t]` is everything it returned up to
 * time `t`. The display stops writing to its stream once its line cap is reached, so what the display
 * itself took from the stream is not the reference.
 */
function streamedForDisplay(run: ToolRun, create: SensitiveTextStreamRedactorFactory, flushAtEnd: boolean): string[] {
  const redactor = create();
  const source = toolResultSensitiveValues(run.input);
  const outputs: string[] = [];
  const streamed: string[] = [];
  let output = '';
  let consumed = 0;
  run.chunks.forEach((chunk, index) => {
    output += chunk;
    const result = classifyToolResult(output);
    if (result.kind === 'text') {
      const text = normalizeToolResultText(result.text);
      outputs.push(redactor.write(text.slice(consumed), source));
      consumed = text.length;
      if (run.previews[index] === true) outputs.push(redactor.preview(source));
    }
    streamed.push(outputs.join('\n'));
  });
  if (flushAtEnd) {
    outputs.push(redactor.flush(source));
    streamed.push(outputs.join('\n'));
  }
  return streamed;
}

const TURN = { conversationId: 'conversation', operationId: 'operation', generation: 1 };

/** daemon `toolTurn`: tool_use, then tool_output 1–12 times (`text` and `tail`), then tool_result. */
export function driveToolTurn(run: ToolRun, createRedactor?: SensitiveTextStreamRedactorFactory): StreamObservation {
  const tools = createRedactor === undefined ? new ToolTurn(TURN) : new ToolTurn(TURN, createRedactor);
  const apply = (event: Parameters<ToolTurn['apply']>[0]['event']) => tools.apply({ kind: 'tool_event', eventId: 'event', event });
  const toolActivity = { callId: 'call', operationId: TURN.operationId, generation: TURN.generation };
  apply({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: run.input }, toolActivity });
  let committed = '';
  const moments: string[] = [];
  for (const chunk of run.chunks) {
    for (const output of apply({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: chunk }, toolActivity })) {
      if (output.kind !== 'tool_output') continue;
      committed += output.text;
      moments.push(committed + output.tail);
    }
  }
  for (const output of apply({ type: 'tool_result', data: { id: 'tool', content: '', isError: false }, toolActivity })) {
    if (output.kind === 'tool_completed') committed = output.entry.output;
  }
  moments.push(committed);
  return { committed, moments };
}

/** `ToolActivityDisplay`: the real component; the observation is every printed stream line. */
export function driveToolActivityDisplay(
  run: ToolRun,
  mode: 'compact' | 'expanded',
  createRedactor?: SensitiveTextStreamRedactorFactory,
): StreamObservation {
  const printed: string[] = [];
  const writeLine = (line: string): void => { printed.push(line); };
  const display = createRedactor === undefined
    ? new ToolActivityDisplay(mode, false, writeLine, false)
    : new ToolActivityDisplay(mode, false, writeLine, false, false, createRedactor);
  const shown = (): string => printed.filter((line) => line.startsWith('  │ ')).map((line) => line.slice(4)).join('\n');
  const moments: string[] = [];
  const streamed = createRedactor === undefined ? undefined : streamedForDisplay(run, createRedactor, mode === 'compact');
  display.handle({ type: 'tool_use', data: { id: 'tool', tool: 'Bash', input: run.input } });
  run.chunks.forEach((chunk, index) => {
    display.handle({ type: 'tool_output', data: { id: 'tool', tool: 'Bash', output: chunk } });
    if (run.previews[index] === true) display.flush();
    moments.push(shown());
  });
  // In expanded mode the stream shows only the running output; the completed result is printed
  // from the result view (sanitizeToolResultText), which is not a stream path.
  if (mode === 'expanded') return { committed: moments.at(-1) ?? '', moments, ...(streamed === undefined ? {} : { streamed }) };
  display.handle({ type: 'tool_result', data: { id: 'tool', content: '', isError: false } });
  moments.push(shown());
  return { committed: shown(), moments, ...(streamed === undefined ? {} : { streamed }) };
}

function runningEntry(input: Record<string, unknown>, output: string): ToolActivityEntry {
  return { key: 'tool', context: { callId: 'call', operationId: TURN.operationId, generation: TURN.generation }, toolId: 'tool', tool: 'Bash',
    input, output, status: 'running', association: 'matched', startedAt: 1000, startSequence: 1 };
}

/** `runningResult`: `read(entry)` with an output that grows by each chunk, and `preview(entry)` in between. */
export function driveRunningResult(run: ToolRun, createRedactor?: SensitiveTextStreamRedactorFactory): StreamObservation {
  const result = createRedactor === undefined ? new RunningToolResult() : new RunningToolResult(createRedactor);
  let output = '';
  const moments: string[] = [];
  run.chunks.forEach((chunk, index) => {
    output += chunk;
    const entry = runningEntry(run.input, output);
    result.read(entry);
    if (run.previews[index] === true) moments.push(result.preview(entry).text);
  });
  const last = result.preview(runningEntry(run.input, output));
  moments.push(last.text);
  return { committed: last.text, moments, sensitiveValues: last.sensitiveValues };
}

export const TOOL_PATHS: ReadonlyArray<readonly [name: string, drive: (run: ToolRun, createRedactor?: SensitiveTextStreamRedactorFactory) => StreamObservation]> = [
  ['toolTurn', driveToolTurn],
  ['ToolActivityDisplay (compact)', (run, createRedactor) => driveToolActivityDisplay(run, 'compact', createRedactor)],
  ['ToolActivityDisplay (expanded)', (run, createRedactor) => driveToolActivityDisplay(run, 'expanded', createRedactor)],
  ['runningResult', driveRunningResult],
];

/** How many times each marker appears in `text`. */
// A marker is counted by its core `Zq<n>Zq`: a range that cuts the digits after it (`Zq28Zq|809`)
// leaves the core visible, and that is the marker being visible, not another marker.
export function markerCounts(text: string, pattern: RegExp = /Zq\d+Zq/gu): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(pattern)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  return counts;
}

/** The kinds of markers (by core) `next` shows that `previous` never shows: `markers(next) \ markers(previous)`. */
export function unseenMarkers(next: string, previous: string): string[] {
  const before = markerCounts(previous);
  return [...markerCounts(next).keys()].filter((marker) => !before.has(marker));
}

/** Markers `next` shows more often than `previous` (empty when `next` shows nothing more). */
export function moreMarkers(next: string, previous: string): string[] {
  const before = markerCounts(previous);
  return [...markerCounts(next)].filter(([marker, count]) => count > (before.get(marker) ?? 0)).map(([marker]) => marker);
}

/**
 * Keys only the new reading keeps open across a newline (found against the integration branch):
 * a continuing quote (design 4.3) opens a quote that the previous reading does not see.
 */
export const NEW_ONLY_OPEN_LINES: readonly string[] = [
  "--password=''a'\n",
  "run --token ''a'\n",
  "--token=\"\"'a\n",
  "?token=''\"\n",
  "curl --password=''\"\n",
];

const STREAM_CUT = new RegExp([
  '(?<=tok)(?=en)', '(?<=Authori)(?=zation)', '(?<=\\?to)(?=ken)', '(?<=--pass)(?=word)',
  '(?<=[=:])', '(?=[=:])', '(?<=["\'])', '(?=["\'])', '(?=\\n)', '(?<=\\n)', '(?=@)',
  '(?<=\\[RED)(?=ACTED\\])', '(?<=[\\uD800-\\uDBFF])(?=[\\uDC00-\\uDFFF])',
].join('|'), 'gu');

/** Cuts `text` into 1 to 12 chunks; cuts inside keys, around separators and quotes, at newlines and before `@` come first. */
export function streamCuts(text: string): fc.Arbitrary<string[]> {
  const preferred = [...new Set([...text.matchAll(STREAM_CUT)].map((match) => match.index))];
  const cut = fc.oneof(
    { weight: 3, arbitrary: preferred.length === 0 ? fc.nat(text.length) : fc.constantFrom(...preferred) },
    { weight: 1, arbitrary: fc.nat(text.length) },
  );
  return fc.array(cut, { maxLength: 11 }).map((cuts) => {
    const points = [...new Set(cuts.map((at) => Math.min(at, text.length)))].sort((a, b) => a - b);
    const chunks: string[] = [];
    let from = 0;
    for (const point of points) {
      chunks.push(text.slice(from, point));
      from = point;
    }
    chunks.push(text.slice(from));
    return chunks.filter((chunk, index) => chunk !== '' || index === 0);
  });
}

/** Unit ends of 337062193's stream: the end of every unit its `take` cut, in the written text. */
export function legacyUnitBoundaries(buffer: legacyStream.SensitiveTextStreamBuffer): { boundaries: Set<number>; inPem: () => boolean } {
  const boundaries = new Set<number>();
  let offset = 0;
  const open = buffer as unknown as {
    take: (end: number, substringValues: readonly string[]) => legacyStream.SensitiveTextCommit;
    pemLabel: string | undefined;
  };
  const take = open.take.bind(buffer);
  open.take = (end, substringValues) => {
    const unit = take(end, substringValues);
    offset += unit.text.length;
    if (unit.text !== '') boundaries.add(offset);
    return unit;
  };
  return { boundaries, inPem: () => open.pemLabel !== undefined };
}

/** Later outputs that print part of `text` around `marker` on their own, plus `text` and its lines (design 3, D3). */
export function laterOutputs(text: string, marker: string): string[] {
  const outputs = new Set<string>([marker, `echoed ${marker}`, `later output: ${marker} end`, text, ...text.split(/\r?\n/u)]);
  for (const separator of [/\s+/u, /[;&|]/, /[,"'`]/, /@/, /[:=]/, /[\s;&|,"'`]/u]) {
    for (const piece of text.split(separator)) {
      if (piece.includes(marker)) outputs.add(`echoed ${piece}`);
    }
  }
  return [...outputs].filter((output) => output.includes(marker));
}
