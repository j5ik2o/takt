import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatCodeBlock } from '../../shared/utils/markdown.js';
import { GoalStore } from '../../infra/goals/store.js';
import type { Goal } from '../../infra/goals/schema.js';
import { releaseFormalSpecVerificationArtifacts, runFormalSpecVerification } from '../interactive/formalSpecVerification.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from '../interactive/taskInstructionFormat.js';
import { MCP_RESPONSE_MAX_BYTES, jsonResult as baseJsonResult } from './response.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { assertCwdAllowedByMcpRoot, errorResult, type McpOperationDependencies } from './operations.js';
import { goalSpecificationVerificationInputSchema, type GoalSpecificationVerificationInput } from './schemas.js';

type Notation = 'quint' | 'alloy';
const NOTATIONS: readonly Notation[] = ['quint', 'alloy'];

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

// The whole log section is bounded to a share of the response budget by returning fewer stages;
// each retained stage keeps its exact stdout/stderr paths.
const MAX_REPORTED_LOG_STAGES = 40;
const LOG_SECTION_BUDGET_BYTES = 24 * 1024;

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

  // Budget only for the log section (stage keys + verbatim paths); the rest of the payload is
  // bounded by later stages. A fixed share keeps every reported path readable while leaving room
  // elsewhere. Paths are never shortened: a shortened path could not open the log it names.
  const logSectionBytes = (entries: typeof stageEntries): number =>
    Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)));

  if (logSectionBytes(stageEntries) <= LOG_SECTION_BUDGET_BYTES) {
    notes.push('Every stage log key is retained and read from verification.artifacts.logs[stage].stdout and .stderr, or under verification.artifacts.runDirectory/logs.');
    return verification;
  }

  // The key set itself exceeds the share: keep a prefix and summarize the omitted stage names.
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
    return { ...verification, artifacts: { ...artifacts, logs: Object.fromEntries(kept) }, logsSummary: summary } as FormalSpecVerificationResult;
  };
  let result = build(keep);
  while (keep > 1 && logSectionBytes(stageEntries.slice(0, keep)) > LOG_SECTION_BUDGET_BYTES) {
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

// When the path list cannot fit the budget, keep the longest prefix of paths that fits and describe
// the rest by count plus a location under the retained run directory (which callers can read
// without the unusable `takt_get_goal` path route). Every returned path stays complete.
interface AlloyOutputSummary {
  returnedCount: number;
  omittedCount: number;
  complete: false;
  retrieval: string;
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
  fits: (value: FormalSpecVerificationResult) => boolean,
): FormalSpecVerificationResult {
  const artifacts = verification.artifacts;
  const outputs = artifacts?.alloyOutputs;
  if (artifacts === undefined || outputs === undefined || outputs.length <= 1) {
    return verification;
  }
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
  if (fits(verification)) return verification;
  let keep = 0;
  let upper = outputs.length - 1;
  while (keep < upper) {
    const count = Math.ceil((keep + upper) / 2);
    if (fits(attempt(count))) keep = count;
    else upper = count - 1;
  }
  return attempt(keep);
}

function boundQuintNameLists(
  verification: FormalSpecVerificationResult,
  notes: string[],
  fits: (value: FormalSpecVerificationResult) => boolean,
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
  while (keep > 1 && !fits(result)) {
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
  fits: (value: FormalSpecVerificationResult) => boolean,
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
      retrieval: `Read all check command numbers from verificationResultPath under verification.artifacts.runDirectory.`,
    } satisfies NumberListSummary,
  } as FormalSpecVerificationResult);

  let keep = MAX_REPORTED_ALLOY_CHECKS;
  let result = build(keep);
  while (keep > 1 && !fits(result)) {
    keep -= 1;
    result = build(keep);
  }
  notes.push(`verification.alloy.checks was summarized to ${keep} of ${checks.length} numbers; the full set is available at verificationResultPath.`);
  return result;
}

// Stage messages can each reach MAX_FAILURE_MESSAGE (8,000 chars); several together can exceed the
// budget. Cap each message and keep the status, noting the retained log location.
const MAX_REPORTED_STAGE_MESSAGE_BYTES = 1024;

function boundStageMessages(
  verification: FormalSpecVerificationResult,
  notes: string[],
): FormalSpecVerificationResult {
  let capped = false;
  const capStage = <T extends { message?: string }>(stage: T): T => {
    if (stage.message === undefined || Buffer.byteLength(stage.message) <= MAX_REPORTED_STAGE_MESSAGE_BYTES) return stage;
    capped = true;
    return { ...stage, message: truncateUtf8(stage.message, MAX_REPORTED_STAGE_MESSAGE_BYTES).value };
  };

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
  if (!capped) return verification;
  notes.push('Some stage messages were truncated; read the full output under verification.artifacts.runDirectory/logs.');
  return { ...verification, quint: nextQuint, alloy: nextAlloy } as FormalSpecVerificationResult;
}

/**
 * Keep artifact and log locations intact even when the verification exceeds 64 KiB. The generic
 * `jsonResult` shortens string fields and slices arrays, which would destroy the paths this tool
 * exists to report. Instead this tool bounds its own payload in stages — returning fewer log
 * stages with verbatim paths, then dropping the re-derivable per-command detail collections,
 * summarizing the artifact path list, bounding number/name lists and stage messages — while keeping
 * the verdict, per-stage statuses and `artifacts.runDirectory` verbatim. Small responses are
 * returned unchanged.
 */
function respondVerification(
  goalId: string, notations: Notation[], verification: FormalSpecVerificationResult,
): ReturnType<typeof baseJsonResult> {
  const payload = (value: FormalSpecVerificationResult, extra: Record<string, unknown> = {}) =>
    ({ goalId, verifiedSpecifications: notations, verification: value, ...extra });
  if (fitsPayload(payload(verification))) return baseJsonResult(payload(verification));

  const resultPath = verification.artifacts && join(verification.artifacts.runDirectory, 'verification-result.json');
  if (resultPath !== undefined) {
    writeFileSync(resultPath, JSON.stringify(verification), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  const notes: string[] = [];
  const summary = (value: FormalSpecVerificationResult) => payload(value, {
    ...(resultPath === undefined ? {} : { verificationResultPath: resultPath }),
    ...(notes.length === 0 ? {} : { notes }),
  });
  const fits = (value: FormalSpecVerificationResult) => fitsPayload(summary(value));
  let trimmed = boundLogStages(verification, notes);
  if (fitsPayload(summary(trimmed))) return baseJsonResult(summary(trimmed));

  const { commands, commandResults, ...alloy } = trimmed.alloy;
  if (commands !== undefined || commandResults !== undefined) {
    trimmed = { ...trimmed, alloy };
    notes.push('Read omitted Alloy command results, including timeouts, from verificationResultPath.');
  }
  if (fitsPayload(summary(trimmed))) return baseJsonResult(summary(trimmed));

  // The artifact path list alone exceeds the budget: summarize it instead of letting the generic
  // shortener slice `alloyOutputs` without any retrieval hint.
  trimmed = boundAlloyOutputs(trimmed, fits);
  if (fitsPayload(summary(trimmed))) return baseJsonResult(summary(trimmed));

  // Quint name lists (invariants/temporal) have no upstream cap; bound them the same way.
  trimmed = boundQuintNameLists(trimmed, notes, fits);
  if (fitsPayload(summary(trimmed))) return baseJsonResult(summary(trimmed));

  // Alloy check numbers are unbounded upstream; bound them like the other lists.
  trimmed = boundAlloyChecks(trimmed, notes, fits);
  if (fitsPayload(summary(trimmed))) return baseJsonResult(summary(trimmed));

  // Long stage messages can each reach 8,000 chars; several together can exceed the budget.
  trimmed = boundStageMessages(trimmed, notes);
  if (fitsPayload(summary(trimmed))) return baseJsonResult(summary(trimmed));

  // Keep the verdict, stage statuses and the full result location if the detailed summary still exceeds the limit.
  const { quint, artifacts } = trimmed;
  return baseJsonResult(payload({
    verdict: trimmed.verdict,
    verificationStarted: trimmed.verificationStarted,
    quint: {
      status: quint.status,
      ...(quint.parse && { parse: { status: quint.parse.status } }),
      ...(quint.typecheck && { typecheck: { status: quint.typecheck.status } }),
      ...(quint.run && { run: { status: quint.run.status } }),
      ...(quint.test && { test: { status: quint.test.status } }),
      ...(quint.verify && { verify: { status: quint.verify.status } }),
    },
    alloy: { status: alloy.status },
    ...(artifacts && { artifacts: { runDirectory: artifacts.runDirectory, specifications: artifacts.specifications, logs: {} } }),
  }, {
    ...(resultPath === undefined ? {} : { verificationResultPath: resultPath }),
    notes: ['Read the complete result, including omitted stage details and log locations, from verificationResultPath.'],
  }));
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
    try {
      return respondVerification(goal.id, notations, verification);
    } finally {
      releaseFormalSpecVerificationArtifacts(verification);
    }
  } catch (error) { return errorResult('Goal specification verification failed', error); }
}
