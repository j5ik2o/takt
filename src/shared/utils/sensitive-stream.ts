// #151, first PR (design 11): the stream is the previous stream. It runs the previous processing
// (hold-back guard, per-unit ranges, repacking, prefix matching) with the frozen copy's functions
// and matches the values the previous implementation tracked (`legacyValues`), so its output is
// what 337062193 printed. The values themselves are still collected in both bounds, and other
// callers read `all` from `sensitiveValues`.
// #151, second PR 2a (design 7.1): the stream is two layers. The inner layer
// (`LegacyStreamUnits`) is the first PR's processing, unchanged, and returns the previous
// units. The outer layer (`SensitiveTextStreamBuffer`) holds those units and commits a run
// of them as one new unit only where the previous stream cut, hiding the union (s1)–(s6)
// per new unit. `createLegacySensitiveTextStreamBuffer` /
// `createLegacySensitiveTextStreamRedactor` expose the inner layer alone, with the first
// PR's behavior; DeepSeek and OpenCode use them explicitly in 2a, so their output does not
// change by a character.
import {
  collectEmbeddedSensitiveValues, knownValueRanges, maskSensitiveRanges, sensitiveTextRanges as legacySensitiveTextRanges, substringSensitiveRanges, REDACTED_VALUE,
  type SensitiveRange,
} from './sensitive-text-legacy.js';
import {
  collectTrackedEmbeddedSensitiveValues, newReadingRanges, previousDisplayRanges, sensitiveTextRanges as newSensitiveTextRanges,
  substringSensitiveRanges as newSubstringSensitiveRanges,
} from './sensitive-text.js';
import { createBoundedSensitiveValues, type BoundedSensitiveValues } from './sensitive-value.js';
import { sliceUtf8 } from './utf8.js';

const PEM_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/u;
const SENSITIVE_PREVIEW_BYTES = 8 * 1024;
const MAX_PENDING_SENSITIVE_LINE_LENGTH = 10_000;

function maskingRangesAndFinds(text: string, values: BoundedSensitiveValues): { ranges: SensitiveRange[]; found: Set<string> } {
  const found = new Set<string>();
  collectEmbeddedSensitiveValues(text, found);
  values.collect({ token: [...found] });
  return { ranges: legacySensitiveTextRanges(text, values.legacyValues), found };
}

function maskingRanges(text: string, values: BoundedSensitiveValues): SensitiveRange[] {
  return maskingRangesAndFinds(text, values).ranges;
}

export interface SensitiveTextStreamRedactor {
  /** 渡された秘密値と、出力の中で見つかった秘密値。 */
  readonly sensitiveValues: BoundedSensitiveValues;
  write(text: string, source: unknown): string;
  flush(source: unknown): string;
  /** まだ確定していない末尾を、マスクして返す。 */
  preview(source: unknown): string;
}

export interface SensitiveTextCommit {
  readonly text: string;
  readonly ranges: readonly SensitiveRange[];
}

/** #151 2a (design 7.1): what the inner-only stream and the stream with the outer hold share. */
export interface SensitiveTextStreamBufferLike {
  readonly sensitiveValues: BoundedSensitiveValues;
  write(text: string, source: unknown, substringValues?: readonly string[], extraRanges?: readonly SensitiveRange[]): SensitiveTextCommit;
  flush(source: unknown, substringValues?: readonly string[]): SensitiveTextCommit;
  preview(source: unknown): string;
}

export type SensitiveTextStreamRedactorFactory = () => SensitiveTextStreamRedactor;

function pendingSensitiveValueRanges(text: string): SensitiveRange[] {
  // ストリーム用にキーや区切りの検出規則を複製しない。'@' は、まだ '@' が届いていない URL の認証情報を保留するため。
  return ['', '"', "'", '\\"', '@'].flatMap((quote) =>
    legacySensitiveTextRanges(text + 'x' + quote, new Set())
      .filter((range) => range.end > text.length)
      .map((range) => ({ start: range.start, end: text.length })));
}

const GUARD_QUOTES = ['', '"', "'", '\\"', '@'] as const;

function pendingNewReadingRanges(text: string): SensitiveRange[] {
  // The outer hold-back guard (design 7.1, 14th edition): the same construction as the
  // previous guard — append `x` and each quote mark, and keep the ranges that run past
  // the end — but read with the new reading (a) alone. The trace (b) and the previous
  // range path (c) are not in it; what the previous reading holds back is the inner
  // layer's business, one previous unit at a time. A range that runs past the end of
  // `text` means the new reading still holds a value open at the end of the held run.
  return GUARD_QUOTES.flatMap((quote) =>
    newReadingRanges(text + 'x' + quote)
      .filter((range) => range.end > text.length)
      .map((range) => ({ start: range.start, end: text.length })));
}

function newReadingGuardReadings(text: string): SensitiveRange[] {
  // Every range the guard's five readings draw over `text`, unclamped: the cut at the cap
  // (rules 3a and 3b) looks for a previous boundary none of them straddles.
  return GUARD_QUOTES.flatMap((quote) => newReadingRanges(text + 'x' + quote));
}

function knownValuePrefixSuffixRanges(text: string, values: ReadonlySet<string>): SensitiveRange[] {
  const ranges: SensitiveRange[] = [];
  for (const value of values) {
    const length = longestValuePrefixAtEnd(text, value);
    if (length > 0) ranges.push({ start: text.length - length, end: text.length });
  }
  return ranges;
}

// text の末尾と一致する、value の真の接頭辞のうち最も長いものの長さ。
// 接頭辞を長い順に endsWith で試すと、長い値（パスワード全体など）で値の長さの2乗になるので、
// KMP の失敗関数で value の先頭と text の末尾を1回ずつ読む。
function longestValuePrefixAtEnd(text: string, value: string): number {
  const limit = Math.min(value.length - 1, text.length);
  if (limit <= 0) return 0;
  const failure = new Int32Array(limit);
  for (let i = 1, k = 0; i < limit; i++) {
    while (k > 0 && value[i] !== value[k]) k = failure[k - 1]!;
    if (value[i] === value[k]) k++;
    failure[i] = k;
  }
  let matched = 0;
  for (let i = text.length - limit; i < text.length; i++) {
    while (matched > 0 && text[i] !== value[matched]) matched = failure[matched - 1]!;
    if (text[i] === value[matched]) matched++;
  }
  return matched;
}

function mergedRanges(ranges: readonly SensitiveRange[]): SensitiveRange[] {
  const ordered = [...ranges].filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SensitiveRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

/** One unit the inner layer cut, with the ranges the previous stream found for it at that time. */
interface LegacyUnit {
  readonly text: string;
  readonly ranges: readonly SensitiveRange[];
  readonly foundValues: readonly string[];
  readonly forced: boolean;
}

/**
 * The inner layer (design 7.1): the first PR's `SensitiveTextStreamBuffer` processing,
 * unchanged, except that `write` runs its loop to the end and returns the previous units
 * it cut, in order, leaving only the not-yet-committed tail in `pending`.
 */
class LegacyStreamUnits {
  readonly sensitiveValues = createBoundedSensitiveValues();
  private pending = '';
  private pemLabel: string | undefined;

  get pendingText(): string {
    return this.pending;
  }

  get pendingLength(): number {
    return this.pending.length;
  }

  get inPemBlock(): boolean {
    return this.pemLabel !== undefined;
  }

  write(text: string, source: unknown, substringValues: readonly string[] = []): LegacyUnit[] {
    this.sensitiveValues.collect(source);
    this.pending += text;
    const units: LegacyUnit[] = [];
    const take = (end: number, forced: boolean): void => {
      units.push(this.take(end, substringValues, forced));
    };
    while (this.pending !== '') {
      if (this.pemLabel !== undefined) {
        const closing = `-----END ${this.pemLabel}-----`;
        const end = this.pending.indexOf(closing);
        if (end < 0) break;
        take(end + closing.length, false);
        continue;
      }
      let newline = this.pending.indexOf('\n');
      while (newline >= 0 && pendingSensitiveValueRanges(this.pending.slice(0, newline + 1)).length > 0) {
        newline = this.pending.indexOf('\n', newline + 1);
      }
      const line = newline < 0 ? this.pending : this.pending.slice(0, newline + 1);
      const begin = PEM_BEGIN.exec(line);
      if (begin !== null) {
        this.pemLabel = begin[1]!;
        continue;
      }
      if (newline >= 0) { take(newline + 1, false); continue; }
      // This is a deliberate best-effort boundary, not a continuing credential context.
      if (this.pending.length > MAX_PENDING_SENSITIVE_LINE_LENGTH) take(this.pending.length, true);
      break;
    }
    return units;
  }

  flush(source: unknown, substringValues: readonly string[] = []): LegacyUnit[] {
    this.sensitiveValues.collect(source);
    if (this.pending === '') return [];
    return [this.take(this.pending.length, substringValues, true)];
  }

  /**
   * The ranges the previous preview used for the pending tail alone. Collects `source`
   * exactly as the previous preview did (only when a tail is pending).
   */
  previewRanges(source: unknown): SensitiveRange[] {
    return this.previewRangesAndFinds(source).ranges;
  }

  /** The previous preview's ranges for the pending tail, and the values its masking found in it. */
  previewRangesAndFinds(source: unknown): { ranges: SensitiveRange[]; foundValues: readonly string[] } {
    if (this.pending === '') return { ranges: [], foundValues: [] };
    this.sensitiveValues.collect(source);
    const text = this.pending;
    // previewだけの発見を、確定済みの候補へ持ち越さない。
    const values = createBoundedSensitiveValues();
    values.collect(this.sensitiveValues);
    const masking = maskingRangesAndFinds(text, values);
    return {
      foundValues: [...masking.found],
      ranges: [
        ...masking.ranges,
        ...pendingSensitiveValueRanges(text),
        ...knownValuePrefixSuffixRanges(text, values.legacyValues),
      ],
    };
  }

  preview(source: unknown): string {
    if (this.pending === '') return '';
    this.sensitiveValues.collect(source);
    if (this.pemLabel !== undefined && this.pending.length > MAX_PENDING_SENSITIVE_LINE_LENGTH) return REDACTED_VALUE;
    const text = this.pending;
    // 左端で切れた秘密値も漏らさないため、保留中の文字列全体をマスクしてから切る。
    // previewだけの発見を、確定済みの候補へ持ち越さない。
    const values = createBoundedSensitiveValues();
    values.collect(this.sensitiveValues);
    const ranges = [
      ...maskingRanges(text, values),
      ...pendingSensitiveValueRanges(text),
      ...knownValuePrefixSuffixRanges(text, values.legacyValues),
    ];
    return sliceUtf8(maskSensitiveRanges(text, ranges), 0, SENSITIVE_PREVIEW_BYTES, true).content;
  }

  private take(end: number, substringValues: readonly string[], forced: boolean): LegacyUnit {
    const text = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    this.pemLabel = undefined;
    const masking = maskingRangesAndFinds(text, this.sensitiveValues);
    return {
      text,
      forced,
      foundValues: [...masking.found],
      ranges: [
        ...masking.ranges,
        ...substringSensitiveRanges(text, substringValues),
        ...knownValuePrefixSuffixRanges(text, this.sensitiveValues.legacyValues),
      ],
    };
  }
}

/** The inner-only stream: a `SensitiveTextStreamBufferLike` over `LegacyStreamUnits` alone. */
class LegacySensitiveTextStreamBuffer implements SensitiveTextStreamBufferLike {
  private readonly inner = new LegacyStreamUnits();

  get sensitiveValues(): BoundedSensitiveValues {
    return this.inner.sensitiveValues;
  }

  write(text: string, source: unknown, substringValues: readonly string[] = [], extraRanges: readonly SensitiveRange[] = []): SensitiveTextCommit {
    if (extraRanges.length > 0) throw new Error('the inner-only stream takes no extra ranges');
    let committed = '';
    const ranges: SensitiveRange[] = [];
    for (const unit of this.inner.write(text, source, substringValues)) {
      for (const range of unit.ranges) ranges.push({ start: committed.length + range.start, end: committed.length + range.end });
      committed += unit.text;
    }
    return { text: committed, ranges };
  }

  flush(source: unknown, substringValues: readonly string[] = []): SensitiveTextCommit {
    let committed = '';
    const ranges: SensitiveRange[] = [];
    for (const unit of this.inner.flush(source, substringValues)) {
      for (const range of unit.ranges) ranges.push({ start: committed.length + range.start, end: committed.length + range.end });
      committed += unit.text;
    }
    return { text: committed, ranges };
  }

  preview(source: unknown): string {
    return this.inner.preview(source);
  }
}

/** A previous unit the outer layer holds, with its per-unit ranges (design 7.1, R9-3). */
interface HeldUnit {
  readonly text: string;
  readonly legacyRanges: readonly SensitiveRange[];
  readonly foundValues: readonly string[];
  readonly substringRanges: readonly SensitiveRange[];
  readonly extraRanges: readonly SensitiveRange[];
  readonly forced: boolean;
}

/**
 * The (s2) trace of one previous unit: the previous display run over the unit with its
 * masking already replaced. The trace is the union of two runs (design 7.1, R12-9): one
 * seeded with the unit's saved ranges alone, and one also seeded with the occurrences of
 * the values the previous collection found in the unit itself, as the previous
 * composition (`sanitizeTextWithValues`) hid the known values before running its
 * patterns; the bound's `collect({ token })` admission drops some of those finds (a
 * quoted space, for one), and the chain across a replaced value needs them. The trace is
 * not monotone in its seed, so neither run replaces the other.
 */
function displayTraceRanges(unit: HeldUnit): SensitiveRange[] {
  const traced = previousDisplayRanges(unit.text, unit.legacyRanges);
  if (unit.foundValues.length === 0) return traced;
  const seeded = [...unit.legacyRanges, ...knownValueRanges(unit.text, new Set(unit.foundValues))];
  return [...traced, ...previousDisplayRanges(unit.text, seeded)];
}

/** Complete value-bearing lines and closed PEM blocks become append-only output. */
export class SensitiveTextStreamBuffer implements SensitiveTextStreamBufferLike {
  private readonly inner = new LegacyStreamUnits();
  private held: HeldUnit[] = [];
  private heldLength = 0;
  private pendingExtraRanges: SensitiveRange[] = [];
  /** The held length when rule 2 last asked the new guard and found it open (design 7.1). */
  private checkedLength = 0;
  /** A preview whose tail the new guard hides from inside the held run (design 7.1, R12-2). */
  private previewMemo: { masked: string; fullLength: number; valuesSize: number } | undefined;

  get sensitiveValues(): BoundedSensitiveValues {
    return this.inner.sensitiveValues;
  }

  write(text: string, source: unknown, substringValues: readonly string[] = [], extraRanges: readonly SensitiveRange[] = []): SensitiveTextCommit {
    // (s6) registration: shift the fourth argument onto the inner pending tail's coordinates.
    const base = this.inner.pendingLength;
    for (const range of extraRanges) {
      const start = Math.max(0, Math.min(range.start, text.length));
      const end = Math.max(0, Math.min(range.end, text.length));
      if (end > start) this.pendingExtraRanges.push({ start: start + base, end: end + base });
    }
    const units = this.inner.write(text, source, substringValues);
    let committed = '';
    const ranges: SensitiveRange[] = [];
    const emit = (unit: SensitiveTextCommit | undefined): void => {
      if (unit === undefined) return;
      for (const range of unit.ranges) ranges.push({ start: committed.length + range.start, end: committed.length + range.end });
      committed += unit.text;
    };
    // The cut at the cap (design 7.1, R12-1): commit up to the last previous boundary the
    // new reading's guard does not straddle, as a non-forced boundary; only if the run is
    // still over the caller's limit afterwards, force the rest out (the last resort, for a
    // single open new value as long as the cap itself).
    const cutAtCap = (stillOver: () => boolean): void => {
      const count = this.closedHeldUnitCount();
      if (count > 0) emit(this.commitHeld(substringValues, count));
      if (this.held.length > 0 && stillOver()) emit(this.commitHeld(substringValues));
    };
    units.forEach((unit, index) => {
      this.hold(unit, substringValues);
      if (unit.forced) {
        // Rule 1: the previous stream cut here under force; the new stream cuts here too.
        emit(this.commitHeld(substringValues));
        return;
      }
      // Rule 2 (design 7.1, 13th edition): asked only at the last unit this write brought
      // in, and only once the held run has doubled since the guard was last asked, so a
      // stream of short writes does not reread the run for every unit.
      let committedByRule = false;
      if (index === units.length - 1 && this.heldLength >= 2 * this.checkedLength) {
        if (pendingNewReadingRanges(this.heldText()).length === 0) {
          emit(this.commitHeld(substringValues));
          committedByRule = true;
        } else {
          this.checkedLength = this.heldLength;
        }
      }
      // Rule 3a: the held run itself is past the cap (the write's unprocessed rest and the
      // inner tail are not added here).
      if (!committedByRule && this.heldLength > MAX_PENDING_SENSITIVE_LINE_LENGTH) {
        cutAtCap(() => this.heldLength > MAX_PENDING_SENSITIVE_LINE_LENGTH);
      }
    });
    // Rule 3b: after the write's units, the held run plus the inner tail is past the cap;
    // cut inside the held run only, never inside the inner tail.
    if (this.held.length > 0 && this.heldLength + this.inner.pendingLength > MAX_PENDING_SENSITIVE_LINE_LENGTH) {
      cutAtCap(() => this.heldLength + this.inner.pendingLength > MAX_PENDING_SENSITIVE_LINE_LENGTH);
    }
    return { text: committed, ranges };
  }

  flush(source: unknown, substringValues: readonly string[] = []): SensitiveTextCommit {
    for (const unit of this.inner.flush(source, substringValues)) this.hold(unit, substringValues);
    const unit = this.commitHeld(substringValues);
    return unit ?? { text: '', ranges: [] };
  }

  preview(source: unknown): string {
    const heldText = this.heldText();
    const innerText = this.inner.pendingText;
    if (heldText === '' && innerText === '') return '';
    // Collect `source` into the real values exactly when the inner-only stream's preview
    // would (a pending inner tail); the preview's own reading below uses a copy, so a
    // preview never carries its discoveries into the committed candidates and never puts
    // anything into the legacy bound the inner-only stream would not have put there.
    const tailPreview = this.inner.previewRangesAndFinds(source);
    const legacyMerged = mergedRanges(tailPreview.ranges);
    const values = createBoundedSensitiveValues();
    values.collect(this.sensitiveValues);
    values.collect(source);
    if (this.inner.inPemBlock && innerText.length > MAX_PENDING_SENSITIVE_LINE_LENGTH) {
      // The previous preview showed none of the pending PEM text (design 7.1, step 2).
      if (heldText === '') return REDACTED_VALUE;
      const heldRanges = this.previewRanges(heldText + innerText, values, legacyMerged, tailPreview.foundValues, [])
        .filter((range) => range.start < heldText.length)
        .map((range) => ({ start: range.start, end: Math.min(range.end, heldText.length) }));
      const masked = maskSensitiveRanges(heldText, heldRanges) + REDACTED_VALUE;
      return sliceUtf8(masked, 0, SENSITIVE_PREVIEW_BYTES, true).content;
    }
    const full = heldText + innerText;
    // The preview memo (design 7.1, R12-2): when the new guard hides the text from a
    // point inside the held run, every later preview hides it too, so the masked prefix
    // up to that point is remembered and returned with the tail replaced — without
    // reading the text again — until the text doubles, the value set changes, or a
    // commit discards the memo.
    if (this.previewMemo !== undefined) {
      const memo = this.previewMemo;
      if (full.length < 2 * memo.fullLength && values.all.size === memo.valuesSize) {
        return sliceUtf8(memo.masked + REDACTED_VALUE, 0, SENSITIVE_PREVIEW_BYTES, true).content;
      }
      this.previewMemo = undefined;
    }
    const guard = pendingNewReadingRanges(full);
    const legacyMasked = maskSensitiveRanges(innerText, legacyMerged);
    const legacySlice = sliceUtf8(legacyMasked, 0, SENSITIVE_PREVIEW_BYTES, true);
    const outerRanges = this.previewRanges(full, values, legacyMerged, tailPreview.foundValues, guard);
    if (heldText !== '' && guard.length > 0) {
      const guardStart = Math.min(...guard.map((range) => range.start));
      if (guardStart < heldText.length) {
        const clipped = outerRanges
          .filter((range) => range.start < guardStart)
          .map((range) => ({ start: range.start, end: Math.min(range.end, guardStart) }));
        this.previewMemo = {
          masked: maskSensitiveRanges(full.slice(0, guardStart), clipped),
          fullLength: full.length,
          valuesSize: values.all.size,
        };
      }
    }
    if (innerText === '' || !legacySlice.truncated) {
      return sliceUtf8(maskSensitiveRanges(full, outerRanges), 0, SENSITIVE_PREVIEW_BYTES, true).content;
    }
    // The previous preview cut `legacySlice.offset` bytes off the left of the masked inner
    // tail. Map that offset back to a position `cutOrig` in the original inner text, and
    // start the window no earlier than the last position before `cutOrig` that the outer
    // ranges leave visible, so nothing the previous preview cut off is shown (R10-1).
    const cutOrig = cutPositionInOriginal(innerText, legacyMerged, legacySlice.offset);
    const heldLength = heldText.length;
    let lastVisible = -1;
    const covered = new Uint8Array(cutOrig);
    for (const range of outerRanges) {
      const start = Math.max(range.start, heldLength);
      const end = Math.min(range.end, heldLength + cutOrig);
      for (let at = start; at < end; at++) covered[at - heldLength] = 1;
    }
    for (let at = 0; at < cutOrig; at++) if (covered[at] !== 1) lastVisible = at;
    const lo = lastVisible < 0 ? 0 : heldLength + lastVisible + 1;
    if (lo === 0) {
      return sliceUtf8(maskSensitiveRanges(full, outerRanges), 0, SENSITIVE_PREVIEW_BYTES, true).content;
    }
    const shifted = outerRanges
      .filter((range) => range.end > lo)
      .map((range) => ({ start: Math.max(range.start, lo) - lo, end: range.end - lo }));
    return sliceUtf8(maskSensitiveRanges(full.slice(lo), shifted), 0, SENSITIVE_PREVIEW_BYTES, true).content;
  }

  private heldText(): string {
    return this.held.map((unit) => unit.text).join('');
  }

  /** Moves one inner unit into the outer hold, cutting its fourth-argument ranges out of `pendingExtraRanges`. */
  private hold(unit: LegacyUnit, substringValues: readonly string[]): void {
    const length = unit.text.length;
    const extra: SensitiveRange[] = [];
    const remaining: SensitiveRange[] = [];
    for (const range of this.pendingExtraRanges) {
      if (range.start < length && range.end > 0) {
        extra.push({ start: Math.max(0, range.start), end: Math.min(length, range.end) });
      }
      if (range.end > length) remaining.push({ start: Math.max(0, range.start - length), end: range.end - length });
    }
    this.pendingExtraRanges = remaining;
    this.held.push({
      text: unit.text,
      legacyRanges: unit.ranges,
      foundValues: unit.foundValues,
      substringRanges: substringSensitiveRanges(unit.text, substringValues),
      extraRanges: extra,
      forced: unit.forced,
    });
    this.heldLength += length;
  }

  /**
   * Commits the first `count` held units (all of them by default) as one new unit,
   * hiding the union (s1)–(s6) (design 7.1). Every commit restarts rule 2's doubling
   * count and discards the preview memo.
   */
  private commitHeld(substringValues: readonly string[], count = this.held.length): SensitiveTextCommit | undefined {
    if (this.held.length === 0) return undefined;
    const units = this.held.slice(0, count);
    this.held = this.held.slice(units.length);
    this.heldLength -= units.reduce((total, unit) => total + unit.text.length, 0);
    this.checkedLength = 0;
    this.previewMemo = undefined;
    const text = units.map((unit) => unit.text).join('');
    const ranges: SensitiveRange[] = [];
    let offset = 0;
    for (const unit of units) {
      // (s1) the ranges the inner layer found for this unit at its own time, (s2) the
      // previous display's trace over this unit, (s4) this unit's own third argument,
      // (s6) this unit's own fourth argument, applied as given.
      for (const range of unit.legacyRanges) ranges.push({ start: offset + range.start, end: offset + range.end });
      for (const range of displayTraceRanges(unit)) ranges.push({ start: offset + range.start, end: offset + range.end });
      for (const range of unit.substringRanges) ranges.push({ start: offset + range.start, end: offset + range.end });
      for (const range of unit.extraRanges) ranges.push({ start: offset + range.start, end: offset + range.end });
      offset += unit.text.length;
    }
    // (s3) the new reading over the whole new unit. Values the new collection finds in the
    // unit are repacked into the new bound only, and only the ones the legacy collection
    // did not find (`all − legacy`, R9-7).
    const found: { legacy: Set<string>; all: Set<string> } = { legacy: new Set(), all: new Set() };
    collectTrackedEmbeddedSensitiveValues(text, found);
    const newOnly = [...found.all].filter((value) => !found.legacy.has(value));
    if (newOnly.length > 0) this.sensitiveValues.collectNewOnly({ token: newOnly });
    // Ranges are appended one by one, never spread into `push`: a long unit can carry
    // more ranges than the call stack takes as arguments (design 6, note 15).
    for (const range of newSensitiveTextRanges(text, this.sensitiveValues.all)) ranges.push(range);
    // (s5) prefixes of known values at the end of the new unit.
    for (const range of knownValuePrefixSuffixRanges(text, this.sensitiveValues.all)) ranges.push(range);
    // (s4) the committing call's third argument over the whole new unit.
    for (const range of newSubstringSensitiveRanges(text, substringValues)) ranges.push(range);
    return { text, ranges };
  }

  /** The union ranges over `full` (held run plus inner tail) for a preview, on the copy `values`. */
  private previewRanges(full: string, values: BoundedSensitiveValues, legacyMerged: readonly SensitiveRange[], tailFinds: readonly string[], guard: readonly SensitiveRange[]): SensitiveRange[] {
    const ranges: SensitiveRange[] = [];
    let offset = 0;
    for (const unit of this.held) {
      for (const range of unit.legacyRanges) ranges.push({ start: offset + range.start, end: offset + range.end });
      for (const range of displayTraceRanges(unit)) ranges.push({ start: offset + range.start, end: offset + range.end });
      for (const range of unit.substringRanges) ranges.push({ start: offset + range.start, end: offset + range.end });
      for (const range of unit.extraRanges) ranges.push({ start: offset + range.start, end: offset + range.end });
      offset += unit.text.length;
    }
    const heldLength = offset;
    const innerText = full.slice(heldLength);
    for (const range of legacyMerged) ranges.push({ start: heldLength + range.start, end: heldLength + range.end });
    // The pending tail gets the same (s2) trace as a held unit (the union of the two runs,
    // R12-9): the previous display run over the tail with its masking already replaced,
    // and the same run also seeded with the occurrences of the values its masking found.
    if (innerText !== '') {
      for (const range of previousDisplayRanges(innerText, legacyMerged)) {
        ranges.push({ start: heldLength + range.start, end: heldLength + range.end });
      }
      if (tailFinds.length > 0) {
        const seeded = [...legacyMerged, ...knownValueRanges(innerText, new Set(tailFinds))];
        for (const range of previousDisplayRanges(innerText, seeded)) {
          ranges.push({ start: heldLength + range.start, end: heldLength + range.end });
        }
      }
    }
    for (const range of this.pendingExtraRanges) ranges.push({ start: heldLength + range.start, end: heldLength + range.end });
    // The new reading over the whole `full` and the prefix ranges are part of every
    // preview: they are what the commit of this text will hide.
    for (const range of newSensitiveTextRanges(full, values.all)) ranges.push(range);
    for (const range of knownValuePrefixSuffixRanges(full, values.all)) ranges.push(range);
    // The new guard over the whole `full`, held units included, always applied as drawn
    // (design 7.1, preview step 4): a line inside a value only the new reading keeps open
    // is not shown before the value closes.
    for (const range of guard) ranges.push(range);
    return ranges;
  }

  /**
   * How many leading held units end at or before the last previous boundary the new
   * reading's guard readings do not straddle (design 7.1, the cut at the cap in rules 3a
   * and 3b). Zero when every unit boundary is straddled.
   */
  private closedHeldUnitCount(): number {
    const readings = newReadingGuardReadings(this.heldText());
    let count = 0;
    let end = 0;
    for (const [index, unit] of this.held.entries()) {
      end += unit.text.length;
      if (!readings.some((range) => range.start < end && end < range.end)) count = index + 1;
    }
    return count;
  }
}

/**
 * Maps a byte offset in the masked inner tail (original segments and `[REDACTED]`
 * segments, in order) back to a UTF-16 position in the original inner text (design 7.1,
 * preview step 5). An offset inside a `[REDACTED]` segment maps to that segment's end in
 * the original text, so nothing of that segment is shown.
 */
function cutPositionInOriginal(innerText: string, merged: readonly SensitiveRange[], offsetBytes: number): number {
  let bytes = 0;
  let position = 0;
  for (const range of merged) {
    const segment = innerText.slice(position, range.start);
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (offsetBytes < bytes + segmentBytes) {
      const delta = Buffer.from(segment, 'utf8').subarray(0, offsetBytes - bytes).toString('utf8').length;
      return position + delta;
    }
    bytes += segmentBytes;
    if (offsetBytes < bytes + REDACTED_VALUE.length) return range.end;
    bytes += REDACTED_VALUE.length;
    position = range.end;
  }
  const segment = innerText.slice(position);
  const segmentBytes = Buffer.byteLength(segment, 'utf8');
  if (offsetBytes < bytes + segmentBytes) {
    const delta = Buffer.from(segment, 'utf8').subarray(0, offsetBytes - bytes).toString('utf8').length;
    return position + delta;
  }
  return innerText.length;
}

/** Preserve text/thinking ownership without moving text across provider channels. */
export function maskSensitiveTextChunks<T extends { text: string }>(commit: SensitiveTextCommit, chunks: T[]): {
  committed: T[]; pending: T[];
} {
  if (commit.text === '') return { committed: [], pending: chunks };
  const sensitive = new Uint8Array(commit.text.length);
  for (const range of commit.ranges) sensitive.fill(1, range.start, range.end);
  const committed: T[] = [];
  const pending: T[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const consumed = Math.min(chunk.text.length, Math.max(0, commit.text.length - offset));
    const ranges: SensitiveRange[] = [];
    for (let index = 0; index < consumed;) {
      if (sensitive[offset + index] !== 1) { index++; continue; }
      const start = index++;
      while (index < consumed && sensitive[offset + index] === 1) index++;
      ranges.push({ start, end: index });
    }
    if (consumed > 0) {
      const masked = maskSensitiveRanges(chunk.text.slice(0, consumed), ranges);
      const continues = sensitive[offset] === 1 && offset > 0 && sensitive[offset - 1] === 1;
      committed.push({ ...chunk, text: continues ? masked.slice(REDACTED_VALUE.length) : masked });
    }
    if (consumed < chunk.text.length) pending.push({ ...chunk, text: chunk.text.slice(consumed) });
    offset += chunk.text.length;
  }
  return { committed, pending };
}

function redactorOf(buffer: SensitiveTextStreamBufferLike): SensitiveTextStreamRedactor {
  const mask = (commit: SensitiveTextCommit): string => maskSensitiveRanges(commit.text, commit.ranges);
  return {
    sensitiveValues: buffer.sensitiveValues,
    write: (text, source) => mask(buffer.write(text, source)),
    flush: (source) => mask(buffer.flush(source)),
    preview: (source) => buffer.preview(source),
  };
}

export function createSensitiveTextStreamRedactor(): SensitiveTextStreamRedactor {
  return redactorOf(new SensitiveTextStreamBuffer());
}

/** #151 2a (design 7.1): the inner-only stream, the first PR's stream. */
export function createLegacySensitiveTextStreamBuffer(): SensitiveTextStreamBufferLike {
  return new LegacySensitiveTextStreamBuffer();
}

/** #151 2a (design 7.1): a redactor over the inner-only stream. */
export function createLegacySensitiveTextStreamRedactor(): SensitiveTextStreamRedactor {
  return redactorOf(new LegacySensitiveTextStreamBuffer());
}
