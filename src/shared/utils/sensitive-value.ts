import {
  REDACTED_VALUE,
  addSensitiveValue,
  collectTrackedEmbeddedSensitiveValues,
  isSensitiveKeyName,
  sanitizeTextWithValues,
  type LegacyStage,
  type TrackedSensitiveValues,
} from './sensitive-text.js';

const MAX_SENSITIVE_VALUE_NODES = 10_000;
export const MAX_TRACKED_SENSITIVE_VALUES = 1_024;
export const MAX_TRACKED_SENSITIVE_VALUE_BYTES = 1024 * 1024;
export const MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES = 16 * 1024;
export const MAX_INSPECTED_BYTES_PER_SOURCE = 16 * 1024 * 1024;

export interface SensitiveValues {
  /** Every collected value (`all`). */
  values: Set<string>;
  /** The values the previous implementation collected from the same source, in its order. */
  legacyValues: Set<string>;
  inspectedBytes: number;
  truncated: boolean;
}

/**
 * One bound on tracked values, with the limits, order and counts the previous
 * BoundedSensitiveValues had (#151, design 1.2).
 */
/** What callers may read of one bound. */
export interface SensitiveValueBoundView {
  readonly values: ReadonlySet<string>;
  readonly exhausted: boolean;
  readonly storedValueBytes: number;
  readonly skippedValueCount: number;
  readonly skippedValueBytes: number;
  readonly truncatedSourceCount: number;
  readonly hasUntrackedValues: boolean;
}

class SensitiveValueBound implements SensitiveValueBoundView {
  readonly values = new Set<string>();
  exhausted = false;
  storedValueBytes = 0;
  skippedValueCount = 0;
  skippedValueBytes = 0;
  truncatedSourceCount = 0;
  inheritedUntrackedValues = false;

  get hasUntrackedValues(): boolean {
    return (
      this.exhausted
      || this.skippedValueCount > 0
      || this.truncatedSourceCount > 0
      || this.inheritedUntrackedValues
    );
  }

  /** Keeps `values` in order until the bound is full; `kept` sees each value it keeps. */
  add(values: Iterable<string>, kept: (value: string) => void, keptElsewhere?: (value: string) => boolean): void {
    for (const value of values) {
      if (this.values.has(value) || keptElsewhere?.(value) === true) continue;
      if (this.values.size >= MAX_TRACKED_SENSITIVE_VALUES || this.storedValueBytes >= MAX_TRACKED_SENSITIVE_VALUE_BYTES) {
        this.exhausted = true;
        break;
      }
      const bytes = Buffer.byteLength(value, 'utf8');
      if (
        bytes > MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES
        || this.storedValueBytes + bytes > MAX_TRACKED_SENSITIVE_VALUE_BYTES
      ) {
        this.skippedValueCount += 1;
        this.skippedValueBytes += bytes;
        continue;
      }
      this.values.add(value);
      this.storedValueBytes += bytes;
      kept(value);
    }
  }

  /** Takes over another bound's values and marks, as the previous collect of a bounded source did. */
  copy(source: SensitiveValueBound, kept: (value: string) => void, keptElsewhere?: (value: string) => boolean): void {
    if (this.exhausted) return;
    if (source.hasUntrackedValues) this.inheritedUntrackedValues = true;
    this.add(source.values, kept, keptElsewhere);
    if (source.exhausted) this.exhausted = true;
  }

  reset(): void {
    this.values.clear();
    this.exhausted = false;
    this.storedValueBytes = 0;
    this.skippedValueCount = 0;
    this.skippedValueBytes = 0;
    this.truncatedSourceCount = 0;
    this.inheritedUntrackedValues = false;
  }
}

/**
 * 予算は「検査した量」ではなく「保持している機密候補」に課金する。
 * Write/Edit 本文などの非機密の大きな入力でも、候補を増やさず継続できる。
 * 1 候補あたりの上限または合計バイト残量を超える候補はその候補だけを見送り、
 * 後続の別の秘密値の追跡は止めない（見送った件数・バイト数で追跡不能を記録する）。
 * 件数上限または合計バイト満杯に達して新規候補を一切保持できないときだけ exhausted にする。
 * 1 つの入力の検査上限（バイト・ノード数）は走査コストのためのもので、超えた入力も
 * それまでに集めた候補を追加し、打ち切り回数を記録したうえで以後の入力の追跡は止めない。
 *
 * 値は2本の上限で持つ（#151）。`legacyBound` は変更前の実装が同じ呼び出しで集めたはずの値を、
 * 変更前と同じ上限・順番・数えで持つ。`newBound` はそれ以外の値を、別の同じ大きさの上限で持つ。
 * 満杯は上限ごとで、満杯になった側だけが止まる。`values` は両方の和集合。
 */
export class BoundedSensitiveValues implements TrackedSensitiveValues {
  readonly values = new Set<string>();
  // The bounds change only through collect, collectNewOnly and reset, which keep `values` their union.
  private readonly legacySide = new SensitiveValueBound();
  private readonly newSide = new SensitiveValueBound();
  private readonly keep = (value: string): void => {
    this.values.add(value);
  };

  get all(): ReadonlySet<string> {
    return this.values;
  }

  get legacy(): ReadonlySet<string> {
    return this.legacySide.values;
  }

  get legacyValues(): ReadonlySet<string> {
    return this.legacySide.values;
  }

  get legacyBound(): SensitiveValueBoundView {
    return this.legacySide;
  }

  get newBound(): SensitiveValueBoundView {
    return this.newSide;
  }

  get legacyExhausted(): boolean {
    return this.legacySide.exhausted;
  }

  get newExhausted(): boolean {
    return this.newSide.exhausted;
  }

  /** Either bound is full. For reporting only. */
  get exhausted(): boolean {
    return this.legacySide.exhausted || this.newSide.exhausted;
  }

  /** Either bound left a value untracked. For reporting only. */
  get hasUntrackedValues(): boolean {
    return this.legacySide.hasUntrackedValues || this.newSide.hasUntrackedValues;
  }

  get storedValueBytes(): number {
    return this.legacySide.storedValueBytes + this.newSide.storedValueBytes;
  }

  get skippedValueCount(): number {
    return this.legacySide.skippedValueCount + this.newSide.skippedValueCount;
  }

  get skippedValueBytes(): number {
    return this.legacySide.skippedValueBytes + this.newSide.skippedValueBytes;
  }

  get truncatedSourceCount(): number {
    return Math.max(this.legacySide.truncatedSourceCount, this.newSide.truncatedSourceCount);
  }

  collect(source: unknown): void {
    if (source === this) return;
    if (source instanceof BoundedSensitiveValues) {
      // Each bound copies the same bound of the source; the either-bound marks are not copied.
      this.legacySide.copy(source.legacySide, this.keep);
      this.newSide.copy(source.newSide, this.keep, (value) => this.legacySide.values.has(value));
      return;
    }
    if (this.legacySide.exhausted && this.newSide.exhausted) return;
    const collected = collectSensitiveStringValues(source, MAX_INSPECTED_BYTES_PER_SOURCE);
    if (!this.legacySide.exhausted) {
      if (collected.truncated) this.legacySide.truncatedSourceCount += 1;
      this.legacySide.add(collected.legacyValues, this.keep);
    }
    this.addNew(collected, (value) => collected.legacyValues.has(value));
  }

  /** Tracks every value of `source` in the new bound only: values repacked from the new reading. */
  collectNewOnly(source: unknown): void {
    if (this.newSide.exhausted) return;
    this.addNew(collectSensitiveStringValues(source, MAX_INSPECTED_BYTES_PER_SOURCE), () => false);
  }

  private addNew(collected: SensitiveValues, fromLegacy: (value: string) => boolean): void {
    if (this.newSide.exhausted) return;
    if (collected.truncated) this.newSide.truncatedSourceCount += 1;
    this.newSide.add(collected.values, this.keep, (value) => fromLegacy(value) || this.legacySide.values.has(value));
  }

  reset(): void {
    this.values.clear();
    this.legacySide.reset();
    this.newSide.reset();
  }
}

export function createBoundedSensitiveValues(): BoundedSensitiveValues {
  return new BoundedSensitiveValues();
}

interface ValueWorkItem {
  value: unknown;
  key?: string;
  sensitiveContext: boolean;
}

interface SanitizeWorkItem {
  value: unknown;
  key?: string;
  target: Record<string, unknown> | unknown[];
  targetKey: string | number;
}

type ValueEntry = readonly [string, unknown];

export interface SensitiveStringReplacement {
  readonly value: unknown;
}

export type SensitiveStringReplacer = (
  value: string,
  key: string | undefined,
) => SensitiveStringReplacement | undefined;

const NO_TRACKED_VALUES: TrackedSensitiveValues = { all: new Set(), legacy: new Set() };

function trackedValues(collected: SensitiveValues): TrackedSensitiveValues {
  return { all: collected.values, legacy: collected.legacyValues };
}

export function sanitizeSensitiveValue(value: unknown, key?: string): unknown {
  return sanitizeValue(value, key, NO_TRACKED_VALUES, undefined);
}

export function sanitizeSensitiveValueWithStringReplacer(
  value: unknown,
  replacer: SensitiveStringReplacer,
): unknown {
  const sensitiveValues = collectSensitiveStringValues(value);
  return sanitizeValue(
    value,
    undefined,
    trackedValues(sensitiveValues),
    replacer,
  );
}

export function sanitizeSensitiveValueWithKnownValues(
  value: unknown,
  source: unknown,
  key?: string,
): unknown {
  const sensitiveValues = collectSensitiveStringValues(source);
  return sanitizeValue(
    value,
    key,
    trackedValues(sensitiveValues),
    undefined,
  );
}

export function sanitizeSensitiveTextWithKnownValues(text: string, source: unknown): string {
  const sensitiveValues = collectSensitiveStringValues(source);
  return sanitizeTextWithValues(text, trackedValues(sensitiveValues));
}

/**
 * What `sanitizeSensitiveValueWithKnownValues(sanitizeSensitiveValueWithStringReplacer(value,
 * replacer), source)` hid, in one pass over the original strings, for output that the display
 * redaction runs over once more (the phase 1 log). The previous implementation chained the two
 * maskings and the display; what that hid is hidden as well (#151).
 */
export function sanitizeSensitiveValueWithStringReplacerAndKnownValues(
  value: unknown,
  replacer: SensitiveStringReplacer,
  source: unknown,
): unknown {
  const own = collectSensitiveStringValues(value);
  const known = collectSensitiveStringValues(source);
  const tracked: TrackedSensitiveValues = {
    all: new Set([...own.values, ...known.values]),
    legacy: new Set([...own.legacyValues, ...known.legacyValues]),
  };
  return sanitizeValue(value, undefined, tracked, replacer, [
    { knownValues: own.legacyValues }, 'display', { knownValues: known.legacyValues }, 'display', 'display',
  ]);
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  knownValues: TrackedSensitiveValues,
  stringReplacer: SensitiveStringReplacer | undefined,
  previous?: readonly LegacyStage[],
): unknown {
  const holder: Record<string, unknown> = {};
  const work: SanitizeWorkItem[] = [{ value, key, target: holder, targetKey: 'value' }];
  const seen = new WeakSet<object>();

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.key !== undefined && isSensitiveKeyName(item.key)) {
      assignSanitized(item.target, item.targetKey, REDACTED_VALUE);
      continue;
    }
    if (typeof item.value === 'string') {
      const replacement = stringReplacer?.(item.value, item.key);
      assignSanitized(
        item.target,
        item.targetKey,
        replacement !== undefined
          ? replacement.value
          : sanitizeTextWithValues(item.value, knownValues, previous),
      );
      continue;
    }
    if (item.value === null || typeof item.value !== 'object') {
      assignSanitized(item.target, item.targetKey, item.value);
      continue;
    }
    if (seen.has(item.value)) {
      assignSanitized(item.target, item.targetKey, REDACTED_VALUE);
      continue;
    }
    const entries = Object.entries(item.value);
    seen.add(item.value);
    const valueIsArray = Array.isArray(item.value);
    const output: Record<string, unknown> | unknown[] = valueIsArray
      ? new Array((item.value as unknown[]).length)
      : {};
    assignSanitized(item.target, item.targetKey, output);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [entryKey, entryValue] = entries[index]!;
      work.push({
        value: entryValue,
        key: valueIsArray ? undefined : entryKey,
        target: output,
        targetKey: valueIsArray ? Number(entryKey) : entryKey,
      });
    }
  }
  return holder['value'];
}

export function collectSensitiveStringValues(
  source: unknown,
  maxInspectedBytes = Number.POSITIVE_INFINITY,
): SensitiveValues {
  if (source instanceof BoundedSensitiveValues) {
    return {
      values: new Set(source.values),
      legacyValues: new Set(source.legacyValues),
      inspectedBytes: 0,
      truncated: source.hasUntrackedValues,
    };
  }
  const result: SensitiveValues = { values: new Set(), legacyValues: new Set(), inspectedBytes: 0, truncated: false };
  const work: ValueWorkItem[] = [{ value: source, sensitiveContext: false }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  while (work.length > 0) {
    const item = work.pop()!;
    visitedNodes += 1;
    const sensitiveContext = item.sensitiveContext
      || (item.key !== undefined && isSensitiveKeyName(item.key));
    if (item.key !== undefined) {
      result.inspectedBytes += Buffer.byteLength(item.key);
    }
    if (typeof item.value === 'string') {
      result.inspectedBytes += Buffer.byteLength(item.value);
      if (result.inspectedBytes > maxInspectedBytes) {
        result.truncated = true;
        break;
      }
      // A value found by its key is what the previous implementation collected as well.
      if (sensitiveContext) {
        addSensitiveValue(result.legacyValues, item.value, item.key);
        addSensitiveValue(result.values, item.value, item.key);
      }
      collectTrackedEmbeddedSensitiveValues(item.value, { legacy: result.legacyValues, all: result.values });
      continue;
    }
    if (result.inspectedBytes > maxInspectedBytes) {
      result.truncated = true;
      break;
    }
    if (item.value === null || typeof item.value !== 'object' || seen.has(item.value)) {
      continue;
    }
    const entries = boundedEntries(
      item.value,
      MAX_SENSITIVE_VALUE_NODES - visitedNodes - work.length,
    );
    if (entries === undefined) {
      result.truncated = true;
      break;
    }
    seen.add(item.value);
    const inheritedSensitiveContext = sensitiveContext;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [entryKey, entryValue] = entries[index]!;
      work.push({
        value: entryValue,
        key: Array.isArray(item.value) ? item.key : entryKey,
        sensitiveContext: inheritedSensitiveContext,
      });
    }
  }
  return result;
}

function boundedEntries(value: object, remainingNodes: number): ValueEntry[] | undefined {
  if (remainingNodes < 0) {
    return undefined;
  }
  if (Array.isArray(value) && value.length > remainingNodes) {
    return undefined;
  }
  const entries: ValueEntry[] = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    if (entries.length >= remainingNodes) {
      return undefined;
    }
    entries.push([key, (value as Record<string, unknown>)[key]]);
  }
  return entries;
}

function assignSanitized(
  target: Record<string, unknown> | unknown[],
  key: string | number,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
