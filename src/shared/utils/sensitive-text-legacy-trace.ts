import {
  BARE_BEARER_VALUE_REGEX,
  KNOWN_TOKEN_REGEX,
  PEM_PRIVATE_KEY_REGEX,
  REDACTED_VALUE,
  SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX,
  SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX,
  SENSITIVE_HEADER_ASSIGNMENT_BARE_VALUE_REGEX,
  SENSITIVE_HEADER_ASSIGNMENT_COLON_VALUE_REGEX,
  SENSITIVE_OPTION_VALUE_REGEX,
  SENSITIVE_QUERY_VALUE_REGEX,
  URL_USERINFO_CREDENTIALS_REGEX,
  curlUserMatches,
  httpHeaderValues,
  knownValueRanges,
  mergedRanges,
  sensitiveTextRanges,
  type SensitiveRange,
} from './sensitive-text-legacy.js';

// The trace of the previous `sanitizeSensitiveText` (#151, design 4.1). It replaced one pattern at
// a time, each on the output of the one before, so a replacement can join text that was apart and
// let a later pattern run over it. The trace applies the frozen copy's patterns in the same order
// and with the same replacement strings, and keeps the output as a list of replacements on the
// original text, so it can say which original characters ended up hidden. Its final `view` is the
// string the previous implementation returned (checked by the fidelity property tests).

/** The original text in [start, end) shows as `text` in the view. Ordered and disjoint. */
interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** One replacement a step makes, in view positions. Only [hideFrom, end) of it hides characters. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly hideFrom: number;
}

type Step = (view: string) => Edit[];

export interface LegacyTrace {
  /** Original characters the previous output did not show, merged. */
  readonly ranges: SensitiveRange[];
  /** The previous output. */
  readonly view: string;
}

const redact = (start: number, end: number): Edit => ({ start, end, text: REDACTED_VALUE, hideFrom: start });

/** `$1[REDACTED]$3`-style replacements: only the value group changes. */
const valueGroup = (pattern: RegExp, prefixGroups: readonly number[], valueGroupIndex: number | 'rest'): Step => (view) => {
  const edits: Edit[] = [];
  for (const match of view.matchAll(pattern)) {
    let start = match.index;
    for (const group of prefixGroups) start += match[group]!.length;
    const end = valueGroupIndex === 'rest' ? match.index + match[0].length : start + match[valueGroupIndex]!.length;
    edits.push(redact(start, end));
  }
  return edits;
};

const wholeMatch = (pattern: RegExp): Step => (view) =>
  [...view.matchAll(pattern)].map((match) => redact(match.index, match.index + match[0].length));

const quotedAssignment: Step = (view) => [...view.matchAll(SENSITIVE_ASSIGNMENT_QUOTED_VALUE_REGEX)].map((match) => {
  const quoteWidth = match[2]!.startsWith('\\"') ? 2 : 1;
  // `token=""` becomes `token="[REDACTED]"`: an insertion that hides nothing but changes the view.
  return redact(match.index + match[1]!.length + quoteWidth, match.index + match[0].length - quoteWidth);
});

// `redactHttpHeaders` replaced [start, end) with `scheme [REDACTED]`, so `Bearer\t\tx` shows one
// space. The scheme stays readable; only the credential is hidden.
const httpHeaders: Step = (view) => [...httpHeaderValues(view)].map(({ start, credentialStart, end, scheme }) => ({
  start,
  end,
  text: scheme === undefined ? REDACTED_VALUE : scheme + ' ' + REDACTED_VALUE,
  hideFrom: credentialStart,
}));

const curlUsers = (form: 'equals' | 'space' | 'compact'): Step => (view) =>
  curlUserMatches(view, form).map((match) => redact(match.replaceStart, match.end));

/** The 14 steps of the previous `sanitizeSensitiveText`, in its order. */
export const LEGACY_STEPS: readonly Step[] = [
  wholeMatch(PEM_PRIVATE_KEY_REGEX),
  quotedAssignment,
  valueGroup(URL_USERINFO_CREDENTIALS_REGEX, [1], 2),
  valueGroup(BARE_BEARER_VALUE_REGEX, [1], 2),
  httpHeaders,
  curlUsers('equals'),
  curlUsers('space'),
  curlUsers('compact'),
  valueGroup(SENSITIVE_HEADER_ASSIGNMENT_BARE_VALUE_REGEX, [1], 2),
  valueGroup(SENSITIVE_HEADER_ASSIGNMENT_COLON_VALUE_REGEX, [1], 2),
  valueGroup(SENSITIVE_ASSIGNMENT_BARE_VALUE_REGEX, [1], 2),
  valueGroup(SENSITIVE_OPTION_VALUE_REGEX, [1], 'rest'),
  valueGroup(SENSITIVE_QUERY_VALUE_REGEX, [1], 2),
  wholeMatch(KNOWN_TOKEN_REGEX),
];

/**
 * One redaction the previous implementation ran over the output of the one before: its display,
 * its known-value masking (`maskSensitiveRanges(text, knownValueRanges(text, values))`), or its
 * range path (`maskSensitiveRanges(text, sensitiveTextRanges(text, values))`).
 */
export type LegacyStage =
  | 'display'
  | { readonly knownValues: ReadonlySet<string> }
  | { readonly ranges: ReadonlySet<string> };

/** Replaces each merged range by REDACTED_VALUE, as maskSensitiveRanges did. */
const maskStep = (find: (view: string) => SensitiveRange[]): Step => (view) =>
  mergedRanges(find(view)).map(({ start, end }) => redact(start, end));

/** The steps of a chain of previous redactions, each run over the output of the one before. */
export function legacyStageSteps(stages: readonly LegacyStage[]): Step[] {
  return stages.flatMap((stage): readonly Step[] => {
    if (stage === 'display') return LEGACY_STEPS;
    if ('knownValues' in stage) return [maskStep((view) => knownValueRanges(view, stage.knownValues))];
    return [maskStep((view) => sensitiveTextRanges(view, stage.ranges))];
  });
}

/**
 * What the previous `sanitizeSensitiveText` hid, as ranges on `text`. `initial` is hidden first,
 * as the previous `sanitizeTextWithValues` hid the known values before running the patterns.
 */
export function legacySequentialRanges(
  text: string,
  initial: readonly SensitiveRange[],
  steps: readonly Step[] = LEGACY_STEPS,
): LegacyTrace {
  const merged = mergedRanges(initial);
  let replacements: Replacement[] = merged.map(({ start, end }) => ({ start, end, text: REDACTED_VALUE }));
  const hidden: SensitiveRange[] = [...merged];
  let view = replacements.length === 0 ? text : render(text, replacements);
  for (const step of steps) {
    const edits = step(view);
    if (edits.length === 0) continue;
    replacements = applyEdits(view, replacements, edits, hidden);
    view = render(text, replacements);
  }
  return { ranges: mergedRanges(hidden), view };
}

function render(text: string, replacements: readonly Replacement[]): string {
  const parts: string[] = [];
  let copied = 0;
  for (const replacement of replacements) {
    parts.push(text.slice(copied, replacement.start), replacement.text);
    copied = replacement.end;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

/** How much longer the view is than the original text over this replacement. */
const growth = (replacement: Replacement): number => replacement.text.length - (replacement.end - replacement.start);

/**
 * Applies one step's edits (ordered, disjoint, in positions of `view`, the output of the step
 * before) to the replacements, and adds the original characters they hide to `hidden`. An edit that
 * overlaps earlier replacements, or an insertion that touches one, becomes one replacement with
 * them, widened to both ends. Further edits of the same step that overlap the same replacements
 * join it, all read in the coordinates of `view`.
 */
function applyEdits(
  view: string,
  replacements: readonly Replacement[],
  edits: readonly Edit[],
  hidden: SensitiveRange[],
): Replacement[] {
  const next: Replacement[] = [];
  let index = 0;
  // View position minus original position, after the replacements before `index`.
  let shift = 0;
  let editIndex = 0;
  while (editIndex < edits.length) {
    const edit = edits[editIndex]!;
    const insertion = edit.start === edit.end;
    while (index < replacements.length) {
      const replacement = replacements[index]!;
      const viewEnd = replacement.start + shift + replacement.text.length;
      if (insertion ? viewEnd >= edit.start : viewEnd > edit.start) break;
      next.push(replacement);
      shift += growth(replacement);
      index += 1;
    }
    const shiftBefore = shift;
    const group: GroupMember[] = [];
    const take = (taken: Edit): void => {
      const takenInsertion = taken.start === taken.end;
      while (index < replacements.length) {
        const replacement = replacements[index]!;
        const viewStart = replacement.start + shift;
        if (takenInsertion ? viewStart > taken.start : viewStart >= taken.end) break;
        group.push({ replacement, viewStart, overlapped: !takenInsertion });
        shift += growth(replacement);
        index += 1;
      }
    };
    take(edit);
    const cluster: Edit[] = [edit];
    for (;;) {
      const last = group.at(-1);
      const following = edits[editIndex + cluster.length];
      if (last === undefined || following === undefined) break;
      const lastViewEnd = last.viewStart + last.replacement.text.length;
      const followingInsertion = following.start === following.end;
      if (followingInsertion ? following.start > lastViewEnd : following.start >= lastViewEnd) break;
      if (!followingInsertion) last.overlapped = true;
      cluster.push(following);
      take(following);
    }
    editIndex += cluster.length;
    const first = group[0];
    const last = group.at(-1);
    if (first === undefined || last === undefined) {
      next.push({ start: edit.start - shiftBefore, end: edit.end - shiftBefore, text: edit.text });
      if (!insertion) hidden.push({ start: edit.hideFrom - shiftBefore, end: edit.end - shiftBefore });
      continue;
    }
    const firstEdit = cluster[0]!;
    const lastEdit = cluster.at(-1)!;
    const lastViewEnd = last.viewStart + last.replacement.text.length;
    const viewStart = Math.min(firstEdit.start, first.viewStart);
    const viewEnd = Math.max(lastEdit.end, lastViewEnd);
    const parts: string[] = [view.slice(viewStart, firstEdit.start)];
    cluster.forEach((member, position) => {
      parts.push(member.text, view.slice(member.end, cluster[position + 1]?.start ?? viewEnd));
    });
    const start = first.viewStart < firstEdit.start ? first.replacement.start : firstEdit.start - shiftBefore;
    const end = lastViewEnd > lastEdit.end ? last.replacement.end : lastEdit.end - shift;
    next.push({ start, end, text: parts.join('') });
    for (const member of group) if (member.overlapped) hidden.push({ start: member.replacement.start, end: member.replacement.end });
    for (const member of cluster) {
      if (member.start === member.end) continue;
      hidden.push({ start: originalAt(member.hideFrom, group, shiftBefore, false), end: originalAt(member.end, group, shiftBefore, true) });
    }
  }
  while (index < replacements.length) next.push(replacements[index++]!);
  return next;
}

interface GroupMember {
  readonly replacement: Replacement;
  readonly viewStart: number;
  overlapped: boolean;
}

/**
 * The original position of view position `position`. Inside a replacement it is the start of the
 * replacement, or its end with `roundUp`.
 */
function originalAt(position: number, group: readonly GroupMember[], shiftBefore: number, roundUp: boolean): number {
  let shift = shiftBefore;
  for (const { replacement, viewStart } of group) {
    if (position <= viewStart) break;
    if (position < viewStart + replacement.text.length) return roundUp ? replacement.end : replacement.start;
    shift += growth(replacement);
  }
  return position - shift;
}
