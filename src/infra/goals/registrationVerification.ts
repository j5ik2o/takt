import { resolveManagerConfig } from '../config/managerConfig.js';
import { resolveFormalSpecConfigurationWithoutPrompt } from '../config/formalSpecConfig.js';
import {
  cleanupFormalSpecVerificationArtifacts,
  runFormalSpecVerification,
  type FormalSpecStageResult,
} from '../formal-spec/formalSpecVerifier.js';
import { formatCodeBlock } from '../../shared/utils/markdown.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { GoalStore } from './store.js';
import { appendGoalWorkLog } from './workLog.js';
import type { Goal } from './schema.js';

function stageSummary(language: string, result: FormalSpecStageResult): string {
  const message = result.message === undefined ? '' : `: ${truncateUtf8(result.message, 1_024).value}`;
  return `${language}: ${result.status}${message}`;
}

export async function verifyRegisteredGoal(cwd: string, goal: Goal, signal: AbortSignal | undefined): Promise<Goal> {
  const specifications = goal.specifications;
  if (specifications?.quint === undefined && specifications?.alloy === undefined) return goal;
  const store = new GoalStore(cwd);
  const notRequired = () => store.update(goal.id, (current) => ({ ...current, registrationVerification: { status: 'not_required' } }));
  if (!resolveManagerConfig(cwd).verifyOnRegister) return notRequired();
  const configuration = resolveFormalSpecConfigurationWithoutPrompt(cwd);
  if (!configuration.mode) return notRequired();
  const blocks = [
    ...(specifications.quint === undefined ? [] : [formatCodeBlock(specifications.quint, 'quint')]),
    ...(specifications.alloy === undefined ? [] : [formatCodeBlock(specifications.alloy, 'alloy')]),
  ];
  const result = await runFormalSpecVerification(blocks.join('\n\n'), cwd, {
    abortSignal: signal, modelCheckTimeoutSeconds: configuration.modelCheckTimeoutSeconds,
  });
  try {
    const summary = [
      `Formal specification verification: ${result.verdict}`,
      ...(specifications.quint === undefined ? [] : [stageSummary('Quint', result.quint)]),
      ...(specifications.alloy === undefined ? [] : [stageSummary('Alloy', result.alloy)]),
      ...(result.message === undefined ? [] : [truncateUtf8(result.message, 2_048).value]),
    ].join('\n');
    return await store.update(goal.id, (current) => {
      const updated = appendGoalWorkLog(current, { summary });
      return { ...updated, registrationVerification: { status: 'completed', workLogId: updated.workLog.at(-1)!.id } };
    });
  } finally {
    cleanupFormalSpecVerificationArtifacts(result);
  }
}
