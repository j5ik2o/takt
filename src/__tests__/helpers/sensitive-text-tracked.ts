import { collectTrackedEmbeddedSensitiveValues, type TrackedSensitiveValues } from '../../shared/utils/sensitive-text.js';

/** The values tracked from `text`: what the previous collection found (`legacy`) and every value (`all`). */
export function trackedValuesOf(text: string): TrackedSensitiveValues & { legacy: Set<string>; all: Set<string> } {
  const into = { legacy: new Set<string>(), all: new Set<string>() };
  collectTrackedEmbeddedSensitiveValues(text, into);
  return into;
}
