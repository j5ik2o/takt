import {
  REDACTED_VALUE,
  addSensitiveValue,
  collectEmbeddedSensitiveValues,
  isSensitiveKeyName,
  sanitizeTextWithValues,
} from './sensitive-text.js';

const MAX_SENSITIVE_VALUE_NODES = 10_000;
export const MAX_TRACKED_SENSITIVE_VALUES = 1_024;
export const MAX_TRACKED_SENSITIVE_VALUE_BYTES = 1024 * 1024;
export const MAX_TRACKED_SENSITIVE_SINGLE_VALUE_BYTES = 16 * 1024;
export const MAX_INSPECTED_BYTES_PER_SOURCE = 16 * 1024 * 1024;

export interface SensitiveValues {
  values: Set<string>;
  inspectedBytes: number;
  truncated: boolean;
}

/**
 * 予算は「検査した量」ではなく「保持している機密候補」に課金する。
 * Write/Edit 本文などの非機密の大きな入力でも、候補を増やさず継続できる。
 * 1 候補あたりの上限または合計バイト残量を超える候補はその候補だけを見送り、
 * 後続の別の秘密値の追跡は止めない（見送った件数・バイト数で追跡不能を記録する）。
 * 件数上限または合計バイト満杯に達して新規候補を一切保持できないときだけ exhausted にする。
 * 1 つの入力の検査上限（バイト・ノード数）は走査コストのためのもので、超えた入力も
 * それまでに集めた候補を追加し、打ち切り回数を記録したうえで以後の入力の追跡は止めない。
 */
export class BoundedSensitiveValues {
  readonly values = new Set<string>();
  exhausted = false;
  storedValueBytes = 0;
  skippedValueCount = 0;
  skippedValueBytes = 0;
  truncatedSourceCount = 0;
  private inheritedUntrackedValues = false;

  get hasUntrackedValues(): boolean {
    return (
      this.exhausted
      || this.skippedValueCount > 0
      || this.truncatedSourceCount > 0
      || this.inheritedUntrackedValues
    );
  }

  collect(source: unknown): void {
    if (source === this || this.exhausted) return;
    const isBoundedSource = source instanceof BoundedSensitiveValues;
    if (isBoundedSource && source.hasUntrackedValues) {
      this.inheritedUntrackedValues = true;
    }
    const collected = collectSensitiveStringValues(source, MAX_INSPECTED_BYTES_PER_SOURCE);
    if (!isBoundedSource && collected.truncated) {
      this.truncatedSourceCount += 1;
    }
    for (const value of collected.values) {
      if (this.values.has(value)) continue;
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
    }
    if (isBoundedSource && source.exhausted) {
      this.exhausted = true;
    }
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

export function sanitizeSensitiveValue(value: unknown, key?: string): unknown {
  return sanitizeValue(value, key, new Set(), undefined);
}

export function sanitizeSensitiveValueWithStringReplacer(
  value: unknown,
  replacer: SensitiveStringReplacer,
): unknown {
  const sensitiveValues = collectSensitiveStringValues(value);
  return sanitizeValue(
    value,
    undefined,
    sensitiveValues.values,
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
    sensitiveValues.values,
    undefined,
  );
}

export function sanitizeSensitiveTextWithKnownValues(text: string, source: unknown): string {
  const sensitiveValues = collectSensitiveStringValues(source);
  return sanitizeTextWithValues(text, sensitiveValues.values);
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  knownValues: ReadonlySet<string>,
  stringReplacer: SensitiveStringReplacer | undefined,
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
          : sanitizeTextWithValues(item.value, knownValues),
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
      inspectedBytes: 0,
      truncated: source.hasUntrackedValues,
    };
  }
  const result: SensitiveValues = { values: new Set(), inspectedBytes: 0, truncated: false };
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
      if (sensitiveContext) {
        addSensitiveValue(result.values, item.value, item.key);
      }
      collectEmbeddedSensitiveValues(item.value, result.values);
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
