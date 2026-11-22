import { formatCodeBlock } from '../../shared/utils/markdown.js';
import { GoalStore } from '../../infra/goals/store.js';
import type { Goal } from '../../infra/goals/schema.js';
import { runFormalSpecVerification } from '../interactive/formalSpecVerification.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from '../interactive/taskInstructionFormat.js';
import { MCP_RESPONSE_MAX_BYTES, jsonResult as baseJsonResult } from './response.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { assertCwdAllowedByMcpRoot, errorResult, type McpOperationDependencies } from './operations.js';
import { goalSpecificationVerificationInputSchema, type GoalSpecificationVerificationInput } from './schemas.js';

type Notation = 'quint' | 'alloy';
const NOTATIONS: readonly Notation[] = ['quint', 'alloy'];
// Log paths stay intact so the reported locations remain usable; each log body is capped to a
// readable slice without breaking the JSON envelope for large verifications.
const MAX_LOG_BODY_BYTES = 2048;

function selectGoalsToVerify(
  goal: Goal,
  requested: readonly Notation[] | undefined,
): { notations: Notation[]; blocks: string[] } {
  const saved = goal.specifications;
  if (saved === undefined) throw new Error('No saved formal specification for this goal.');
  const candidates = NOTATIONS.filter((notation) => requested === undefined || requested.includes(notation));
  const savedCandidates = candidates.filter((notation) => {
    const text = saved[notation];
    return text !== undefined && text.trim().length > 0;
  });
  if (savedCandidates.length === 0) {
    if (requested === undefined) throw new Error('No saved formal specification for this goal.');
    throw new Error(`No saved ${candidates.join(' or ')} specification for this goal.`);
  }
  if (requested !== undefined && savedCandidates.length < candidates.length) {
    const missing = candidates.filter((notation) => !savedCandidates.includes(notation));
    throw new Error(`No saved ${missing.join(' or ')} specification for this goal.`);
  }
  const blocks = savedCandidates.map((notation) => formatCodeBlock(saved[notation]!.trim(), notation));
  return { notations: savedCandidates, blocks };
}

async function loadGoal(cwd: string, goalId: string): Promise<Goal> {
  try {
    return await new GoalStore(cwd).get(goalId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|not found/iu.test(message)) throw new Error(`Goal not found: ${goalId}`);
    throw error;
  }
}

type FormalSpecVerificationResult = Awaited<ReturnType<typeof runFormalSpecVerification>>;

// Log bodies are capped per stage and the whole log section is bounded to a share of the response
// budget so every stage key stays resolvable while other fields still fit.
const MAX_REPORTED_LOG_STAGES = 40;
const MIN_LOG_BODY_BYTES = 64;
const LOG_SECTION_BUDGET_BYTES = 24 * 1024;

function capLogBodies(
  stageEntries: ReadonlyArray<readonly [string, { stdout: string; stderr: string }]>,
  bodyBytes: number,
): { logs: Record<string, { stdout: string; stderr: string }>; truncated: boolean } {
  let truncated = false;
  const logs = Object.fromEntries(stageEntries.map(([stage, entry]) => {
    const stdout = truncateUtf8(entry.stdout, bodyBytes);
    const stderr = truncateUtf8(entry.stderr, bodyBytes);
    if (stdout.value !== entry.stdout || stderr.value !== entry.stderr) truncated = true;
    return [stage, { stdout: stdout.value, stderr: stderr.value }];
  }));
  return { logs, truncated };
}

interface LogStagesSummary {
  returnedCount: number;
  omittedCount: number;
  complete: false;
  firstOmittedStage: string;
  lastOmittedStage: string;
  retrieval: string;
}

function boundLogStages(
  verification: FormalSpecVerificationResult,
  notes: string[],
): FormalSpecVerificationResult {
  const artifacts = verification.artifacts;
  if (artifacts === undefined) return verification;
  const stageEntries = Object.entries(artifacts.logs);

  // Budget only for the log section (keys + bodies); the rest of the payload is bounded by later
  // stages. Allocating a fixed share keeps every stage key resolvable while leaving room elsewhere.
  const logSectionBytes = (entries: ReadonlyArray<readonly [string, { stdout: string; stderr: string }]>, bodyBytes: number): number =>
    Buffer.byteLength(JSON.stringify(capLogBodies(entries, bodyBytes).logs));

  const truncatedNote = 'Log stream contents were truncated to a readable slice; every stage key is retained and read from verification.artifacts.logs[stage].stdout and .stderr, or under verification.artifacts.runDirectory/logs.';
  const keysNote = 'Every stage log key is retained and read from verification.artifacts.logs[stage].stdout and .stderr, or under verification.artifacts.runDirectory/logs.';
  // `capLogBodies` only reports truncation when a path/body string was actually shortened; the
  // note must match that measurement rather than firing whenever this stage runs.
  const applyBodyCap = (
    entries: ReadonlyArray<readonly [string, { stdout: string; stderr: string }]>,
    bodyBytes: number,
  ): FormalSpecVerificationResult => {
    const capped = capLogBodies(entries, bodyBytes);
    notes.push(capped.truncated ? truncatedNote : keysNote);
    return { ...verification, artifacts: { ...artifacts, logs: capped.logs } };
  };

  // Fast path: keep every key with 2 KiB bodies if the log section stays within its share.
  if (logSectionBytes(stageEntries, MAX_LOG_BODY_BYTES) <= LOG_SECTION_BUDGET_BYTES) {
    return applyBodyCap(stageEntries, MAX_LOG_BODY_BYTES);
  }

  // 1. Shrink the body cap so every key survives within the log-section share.
  let bodyBytes = MAX_LOG_BODY_BYTES;
  while (bodyBytes > MIN_LOG_BODY_BYTES && logSectionBytes(stageEntries, bodyBytes) > LOG_SECTION_BUDGET_BYTES) {
    bodyBytes = Math.max(MIN_LOG_BODY_BYTES, Math.floor(bodyBytes / 2));
  }
  if (logSectionBytes(stageEntries, bodyBytes) <= LOG_SECTION_BUDGET_BYTES) {
    return applyBodyCap(stageEntries, bodyBytes);
  }

  // 2. The key set itself exceeds the share: keep a prefix and summarize the omitted stage names.
  let keep = Math.min(stageEntries.length, MAX_REPORTED_LOG_STAGES);
  const build = (count: number): FormalSpecVerificationResult => {
    const kept = stageEntries.slice(0, count);
    const omitted = stageEntries.slice(count).map(([stage]) => stage);
    const summary: LogStagesSummary = {
      returnedCount: count,
      omittedCount: omitted.length,
      complete: false,
      firstOmittedStage: omitted[0] ?? '',
      lastOmittedStage: omitted[omitted.length - 1] ?? '',
      retrieval: `${omitted.length} later log stages were omitted; every stage log is under verification.artifacts.runDirectory/logs (stdout/stderr per stage).`,
    };
    return { ...verification, artifacts: { ...artifacts, logs: capLogBodies(kept, MIN_LOG_BODY_BYTES).logs }, logsSummary: summary } as FormalSpecVerificationResult;
  };
  let result = build(keep);
  while (keep > 1 && logSectionBytes(stageEntries.slice(0, keep), MIN_LOG_BODY_BYTES) > LOG_SECTION_BUDGET_BYTES) {
    keep -= 1;
    result = build(keep);
  }
  notes.push(`verification.artifacts.logs lists ${keep} of ${stageEntries.length} stages (${stageEntries.length - keep} omitted); the rest are under verification.artifacts.runDirectory/logs.`);
  return result;
}


// `jsonResult` shortens any payload larger than the budget, so "fits" must measure the candidate
// payload itself (a truncated result is always small and would otherwise read as fitting).
function fitsPayload(value: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }] })) <= MCP_RESPONSE_MAX_BYTES;
}

// When the path list alone cannot fit the budget, keep a bounded window of paths and describe the
// rest by count plus a location relative to the retained run directory (which callers can read
// without the unusable `takt_get_goal` path route).
const MAX_REPORTED_ALLOY_OUTPUTS = 40;

interface AlloyOutputSummary {
  returnedCount: number;
  omittedCount: number;
  complete: false;
  retrieval: string;
}

function isFitting(value: FormalSpecVerificationResult): boolean {
  // The id/notation fields and notes add a small fixed overhead; reserve 4 KiB so the real call
  // site (which includes the actual goalId and notes) still fits when this reports true.
  return fitsPayload({ goalId: 'x'.repeat(64), verifiedSpecifications: ['quint', 'alloy'], verification: value, notes: ['x'.repeat(1024)] });
}

// When a name list alone cannot fit the budget, keep a bounded window and describe the rest by
// count plus a location under the retained run directory.
const MAX_REPORTED_QUINT_NAMES = 40;

interface NameListSummary {
  returnedCount: number;
  omittedCount: number;
  complete: false;
  retrieval: string;
}

function boundAlloyOutputs(
  verification: FormalSpecVerificationResult,
  notes: string[],
): FormalSpecVerificationResult {
  const artifacts = verification.artifacts;
  const outputs = artifacts?.alloyOutputs;
  if (artifacts === undefined || outputs === undefined || outputs.length <= MAX_REPORTED_ALLOY_OUTPUTS) {
    return verification;
  }
  let keep = Math.min(outputs.length, MAX_REPORTED_ALLOY_OUTPUTS);
  const attempt = (count: number): FormalSpecVerificationResult => {
    const summary: AlloyOutputSummary = {
      returnedCount: count,
      omittedCount: outputs.length - count,
      complete: false,
      retrieval: `Read the first ${count} paths here; the remaining ${outputs.length - count} files are under verification.artifacts.runDirectory (alloy-run-<n>/).`,
    };
    return {
      ...verification,
      artifacts: { ...artifacts, alloyOutputs: outputs.slice(0, count) },
      alloyOutputsSummary: summary,
    } as FormalSpecVerificationResult;
  };
  // Find the largest retained window that still fits the budget (paths are similar in size, so a
  // small linear shrink from the cap is enough; fall back to one path if the budget is tiny).
  let value = attempt(keep);
  if (!isFitting(value)) {
    while (keep > 1 && !isFitting(value)) {
      keep = Math.max(1, keep - 1);
      value = attempt(keep);
    }
  }
  notes.push(
    `artifacts.alloyOutputs was summarized to ${keep} of ${outputs.length} paths; the remaining files are under verification.artifacts.runDirectory.`,
  );
  return value;
}

function boundQuintNameLists(
  verification: FormalSpecVerificationResult,
  notes: string[],
): FormalSpecVerificationResult {
  const quint = verification.quint;
  const invariants = quint.invariants;
  const temporal = quint.temporal;
  const invBig = Array.isArray(invariants) && invariants.length > MAX_REPORTED_QUINT_NAMES;
  const tempBig = Array.isArray(temporal) && temporal.length > MAX_REPORTED_QUINT_NAMES;
  if (!invBig && !tempBig) return verification;

  const build = (keep: number): FormalSpecVerificationResult => {
    const invKeep = invBig ? keep : invariants?.length ?? 0;
    const tempKeep = tempBig ? keep : temporal?.length ?? 0;
    const summaries: Record<string, NameListSummary> = {};
    const nextQuint: typeof quint = {
      ...quint,
      ...(invBig ? { invariants: invariants.slice(0, invKeep) } : {}),
      ...(tempBig ? { temporal: temporal!.slice(0, tempKeep) } : {}),
    };
    if (invBig) {
      summaries.quintInvariants = {
        returnedCount: invKeep,
        omittedCount: invariants.length - invKeep,
        complete: false,
        retrieval: `Read the first ${invKeep} names here; the remaining ${invariants.length - invKeep} invariants are recorded in the quint parse artifact under verification.artifacts.parseJson.`,
      };
    }
    if (tempBig) {
      summaries.quintTemporal = {
        returnedCount: tempKeep,
        omittedCount: temporal!.length - tempKeep,
        complete: false,
        retrieval: `Read the first ${tempKeep} names here; the remaining ${temporal!.length - tempKeep} temporal properties are recorded in the quint parse artifact under verification.artifacts.parseJson.`,
      };
    }
    return { ...verification, quint: nextQuint, quintNameListSummaries: summaries } as FormalSpecVerificationResult;
  };

  // Both oversized lists share one window that shrinks until the payload fits (names are similar
  // in size, so this finds the largest retained count that stays within budget).
  let keep = MAX_REPORTED_QUINT_NAMES;
  let result = build(keep);
  while (keep > 1 && !isFitting(result)) {
    keep -= 1;
    result = build(keep);
  }
  if (invBig) notes.push(`verification.quint.invariants was summarized to ${invBig ? keep : invariants.length} of ${invariants.length} names; the rest are under verification.artifacts.parseJson.`);
  if (tempBig) notes.push(`verification.quint.temporal was summarized to ${tempBig ? keep : temporal!.length} of ${temporal!.length} names; the rest are under verification.artifacts.parseJson.`);
  return result;
}

// `alloy.checks` is unbounded upstream (every `check` command number); bound it like the other
// lists once it would push the payload over budget.
const MAX_REPORTED_ALLOY_CHECKS = 40;

interface NumberListSummary {
  returnedCount: number;
  omittedCount: number;
  complete: false;
  retrieval: string;
}

function boundAlloyChecks(
  verification: FormalSpecVerificationResult,
  notes: string[],
): FormalSpecVerificationResult {
  const alloy = verification.alloy;
  const checks = alloy.checks;
  if (!Array.isArray(checks) || checks.length <= MAX_REPORTED_ALLOY_CHECKS) return verification;

  const build = (keep: number): FormalSpecVerificationResult => ({
    ...verification,
    alloy: { ...alloy, checks: checks.slice(0, keep) },
    alloyChecksSummary: {
      returnedCount: keep,
      omittedCount: checks.length - keep,
      complete: false,
      retrieval: `Read the first ${keep} check command numbers here; the full set is recorded in the Alloy specification at verification.artifacts.specifications.alloy, which lives under verification.artifacts.runDirectory.`,
    } satisfies NumberListSummary,
  } as FormalSpecVerificationResult);

  let keep = MAX_REPORTED_ALLOY_CHECKS;
  let result = build(keep);
  while (keep > 1 && !isFitting(result)) {
    keep -= 1;
    result = build(keep);
  }
  notes.push(`verification.alloy.checks was summarized to ${keep} of ${checks.length} numbers; the rest are under verification.artifacts.specifications.alloy.`);
  return result;
}

// Stage messages can each reach MAX_FAILURE_MESSAGE (8,000 chars); several together can exceed the
// budget. Cap each message and keep the status, noting the retained log location.
const MAX_REPORTED_STAGE_MESSAGE_BYTES = 1024;

function boundStageMessages(
  verification: FormalSpecVerificationResult,
  notes: string[],
): FormalSpecVerificationResult {
  const capStage = <T extends { message?: string }>(stage: T): T =>
    typeof stage.message === 'string' && Buffer.byteLength(stage.message) > MAX_REPORTED_STAGE_MESSAGE_BYTES
      ? { ...stage, message: truncateUtf8(stage.message, MAX_REPORTED_STAGE_MESSAGE_BYTES).value }
      : stage;

  const quint = verification.quint;
  const nextQuint = {
    ...quint,
    ...(quint.parse ? { parse: capStage(quint.parse) } : {}),
    ...(quint.typecheck ? { typecheck: capStage(quint.typecheck) } : {}),
    ...(quint.run ? { run: capStage(quint.run) } : {}),
    ...(quint.test ? { test: capStage(quint.test) } : {}),
    ...(quint.verify ? { verify: capStage(quint.verify) } : {}),
  } as typeof quint;
  const nextAlloy = capStage(verification.alloy);
  const capped = nextQuint !== quint || nextAlloy !== verification.alloy;
  if (!capped) return verification;
  notes.push('Some stage messages were truncated; read the full output under verification.artifacts.runDirectory/logs.');
  return { ...verification, quint: nextQuint, alloy: nextAlloy } as FormalSpecVerificationResult;
}

/**
 * Keep artifact and log locations intact even when the verification exceeds 64 KiB. The generic
 * `jsonResult` shortens string fields and slices arrays, which would destroy the paths this tool
 * exists to report. Instead this tool bounds its own payload in stages — capping log bodies, then
 * limiting log stages, then dropping the re-derivable per-command detail collections, and finally
 * summarizing the artifact path list when even the paths exceed the budget — while keeping the
 * verdict, per-stage statuses and `artifacts.runDirectory` verbatim. Small responses are returned
 * unchanged.
 */
function respondVerification(
  goalId: string, notations: Notation[], verification: FormalSpecVerificationResult,
): ReturnType<typeof baseJsonResult> {
  const payload = (value: FormalSpecVerificationResult, extra: Record<string, unknown> = {}) =>
    ({ goalId, verifiedSpecifications: notations, verification: value, ...extra });
  if (fitsPayload(payload(verification))) return baseJsonResult(payload(verification));

  const notes: string[] = [];
  let trimmed: FormalSpecVerificationResult = verification;
  const artifacts = trimmed.artifacts;
  if (artifacts !== undefined) {
    trimmed = boundLogStages(trimmed, notes);
  }
  if (fitsPayload(payload(trimmed, notes.length > 0 ? { notes } : {}))) return baseJsonResult(payload(trimmed, notes.length > 0 ? { notes } : {}));

  if (trimmed.alloy.commands !== undefined || trimmed.alloy.commandResults !== undefined) {
    const restAlloy = Object.fromEntries(
      Object.entries(trimmed.alloy).filter(([key]) => key !== 'commands' && key !== 'commandResults'),
    );
    trimmed = { ...trimmed, alloy: restAlloy as typeof trimmed.alloy };
    notes.push('alloy.commands and alloy.commandResults were omitted; read per-command output from verification.artifacts.alloyOutputs.');
  }
  if (fitsPayload(payload(trimmed, notes.length > 0 ? { notes } : {}))) return baseJsonResult(payload(trimmed, notes.length > 0 ? { notes } : {}));

  // The artifact path list alone exceeds the budget: summarize it instead of letting the generic
  // shortener slice `alloyOutputs` without any retrieval hint.
  trimmed = boundAlloyOutputs(trimmed, notes);
  if (fitsPayload(payload(trimmed, notes.length > 0 ? { notes } : {}))) return baseJsonResult(payload(trimmed, notes.length > 0 ? { notes } : {}));

  // Quint name lists (invariants/temporal) have no upstream cap; bound them the same way.
  trimmed = boundQuintNameLists(trimmed, notes);
  if (fitsPayload(payload(trimmed, notes.length > 0 ? { notes } : {}))) return baseJsonResult(payload(trimmed, notes.length > 0 ? { notes } : {}));

  // Alloy check numbers are unbounded upstream; bound them like the other lists.
  trimmed = boundAlloyChecks(trimmed, notes);
  if (fitsPayload(payload(trimmed, notes.length > 0 ? { notes } : {}))) return baseJsonResult(payload(trimmed, notes.length > 0 ? { notes } : {}));

  // Long stage messages can each reach 8,000 chars; several together can exceed the budget.
  trimmed = boundStageMessages(trimmed, notes);
  if (fitsPayload(payload(trimmed, notes.length > 0 ? { notes } : {}))) return baseJsonResult(payload(trimmed, notes.length > 0 ? { notes } : {}));

  // Every known variable-length field has been bounded; the payload must now fit. As a last resort,
  // shrink the bounded lists (and drop re-derivable detail collections) until the payload fits, so
  // no oversized response ever reaches the generic shortener. Each pass monotonically reduces the
  // payload, so the loop terminates; if it cannot fit, the final `baseJsonResult` shortener is the
  // absolute last resort.
  notes.push('The verification response was bounded to fit 64 KiB; read the retained artifacts under verification.artifacts.runDirectory for full detail.');
  let final: FormalSpecVerificationResult = trimmed;
  for (let window = MAX_REPORTED_ALLOY_CHECKS; !fitsPayload(payload(final, { notes })) && window > 1; window -= 1) {
    final = shrinkVariableLists(final, window);
  }
  return baseJsonResult(payload(final, { notes }));
}

// Reduce every remaining bounded list to `window` entries. Used by the final safety loop so a
// still-oversized payload (e.g. checks + alloyOutputs + long stage messages together) always
// converges instead of falling through to the generic shortener.
function shrinkVariableLists(
  verification: FormalSpecVerificationResult,
  window: number,
): FormalSpecVerificationResult {
  const alloy = verification.alloy;
  const checks = Array.isArray(alloy.checks) ? alloy.checks.slice(0, window) : alloy.checks;
  const artifacts = verification.artifacts;
  const outputs = artifacts?.alloyOutputs;
  const quint = verification.quint;
  const invariants = Array.isArray(quint.invariants) ? quint.invariants.slice(0, window) : quint.invariants;
  const temporal = Array.isArray(quint.temporal) ? quint.temporal.slice(0, window) : quint.temporal;
  const capStage = <T extends { message?: string }>(stage: T): T =>
    typeof stage.message === 'string' && Buffer.byteLength(stage.message) > MAX_REPORTED_STAGE_MESSAGE_BYTES
      ? { ...stage, message: truncateUtf8(stage.message, MAX_REPORTED_STAGE_MESSAGE_BYTES).value }
      : stage;
  const nextQuint = {
    ...quint,
    invariants,
    temporal,
    ...(quint.parse ? { parse: capStage(quint.parse) } : {}),
    ...(quint.typecheck ? { typecheck: capStage(quint.typecheck) } : {}),
    ...(quint.run ? { run: capStage(quint.run) } : {}),
    ...(quint.test ? { test: capStage(quint.test) } : {}),
    ...(quint.verify ? { verify: capStage(quint.verify) } : {}),
  } as typeof quint;
  const alloyWithChecks = {
    ...alloy,
    checks,
    ...(checks === undefined ? {} : { commands: undefined, commandResults: undefined }),
  } as FormalSpecVerificationResult['alloy'];
  const bodyBytes = Math.max(64, Math.floor(MAX_LOG_BODY_BYTES / Math.max(1, Math.ceil(MAX_REPORTED_LOG_STAGES / window))));
  const logEntries = artifacts === undefined ? [] : Object.entries(artifacts.logs);
  const nextArtifacts = artifacts === undefined ? undefined : {
    ...artifacts,
    ...(outputs === undefined ? {} : { alloyOutputs: outputs.slice(0, window) }),
    logs: capLogBodies(logEntries, bodyBytes).logs,
  };
  return {
    ...verification,
    quint: nextQuint,
    alloy: capStage(alloyWithChecks),
    ...(nextArtifacts === undefined ? {} : { artifacts: nextArtifacts }),
  } as FormalSpecVerificationResult;
}

export async function verifyTaktGoalSpecification(
  input: GoalSpecificationVerificationInput, deps: McpOperationDependencies, signal: AbortSignal,
) {
  try {
    let parsed: GoalSpecificationVerificationInput;
    try {
      parsed = goalSpecificationVerificationInputSchema.parse(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult('Input validation error', new Error(message));
    }
    assertCwdAllowedByMcpRoot(parsed.cwd, deps.allowedProjectRoot);
    signal.throwIfAborted();
    const goal = await loadGoal(parsed.cwd, parsed.goalId);
    const { notations, blocks } = selectGoalsToVerify(goal, parsed.specifications);
    signal.throwIfAborted();
    const { modelCheckTimeoutSeconds } = resolveFormalSpecConfigurationWithoutPrompt(parsed.cwd);
    const verification = await runFormalSpecVerification(blocks.join('\n\n'), parsed.cwd, {
      abortSignal: signal, modelCheckTimeoutSeconds,
    });
    return respondVerification(goal.id, notations, verification);
  } catch (error) { return errorResult('Goal specification verification failed', error); }
}
