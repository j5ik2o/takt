import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
  type BoundedSensitiveValues,
} from '../utils/sensitiveText.js';
import { sanitizeTerminalStreamText } from '../utils/text.js';
import { stableToolResultPrefix } from './result.js';

export function normalizeToolResultText(text: string): string {
  return sanitizeTerminalStreamText(stableToolResultPrefix(text));
}

export function toolResultSensitiveValues(source: unknown): ReturnType<typeof createBoundedSensitiveValues> {
  const known = createBoundedSensitiveValues();
  known.collect(source);
  // 本文と秘密値を同じ端末表現で照合し、元の秘密値ソースは変更しない。
  // 変更前の収集から来た値の正規化は collect で、新しい読みだけの値の正規化は新しい側にだけ詰め直す。
  const normalizedLegacy = [...known.legacyValues].map((value) => normalizeToolResultText(value));
  const normalizedNew = [...known.newBound.values].map((value) => normalizeToolResultText(value));
  known.collect({ token: normalizedLegacy });
  known.collectNewOnly({ token: normalizedNew });
  return known;
}

export function sanitizeToolResultText(text: string, source: unknown): string {
  return sanitizeNormalizedToolResultText(text, toolResultSensitiveValues(source));
}

/** 出力と同じ端末表現に揃えた秘密値で照合する。 */
export function sanitizeNormalizedToolResultText(text: string, source: BoundedSensitiveValues): string {
  return sanitizeSensitiveTextWithKnownValues(normalizeToolResultText(text), source);
}
