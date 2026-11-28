import { setTimeout as delay } from 'node:timers/promises';
import { withProjectExecution } from './projectExecution.js';
import { TaskRunner } from '../../../infra/task/index.js';
import { resolveWorkflowConfigValues } from '../../../infra/config/index.js';
import { header, info, status, blankLine, warn } from '../../../shared/ui/index.js';
import { statusLine } from '../../../shared/ui/StatusLine.js';
import {
  getErrorMessage,
  getSlackWebhookUrl,
  notifyError,
  notifySuccess,
  sendSlackNotification,
  buildSlackRunSummary,
  generateRunId,
} from '../../../shared/utils/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import type { RunAllTasksOptions, TaskExecutionOptions } from './types.js';
import { attemptAutoRequeueTask, isAutoRequeueCandidate, runWithWorkerPool } from './parallelExecution.js';
import { toSlackTaskDetail } from './slackSummaryAdapter.js';
import { failInterruptedTasksWithGoalEvents, isClaimLockTimeoutFailure } from './claimTasks.js';
import { checkQueuedTaskProviders, checkPendingTaskProviders, runtimeAssignmentUnavailableReason, terminalProviderConfirmation } from './providerPreflight.js';

export async function runAllTasks(
  cwd: string,
  options?: RunAllTasksOptions,
): Promise<void> {
  return withProjectExecution(cwd, 'run', async (shutdownSignals) => {
    const agentOverrides: TaskExecutionOptions | undefined = options
      ? {
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          ...(options.providerSource !== undefined ? { providerSource: options.providerSource } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.modelSource !== undefined ? { modelSource: options.modelSource } : {}),
          ...(options.autoStrategy !== undefined ? { autoStrategy: options.autoStrategy } : {}),
        }
      : undefined;
    const taskRunner = new TaskRunner(cwd, { onWarning: warn });
    const globalConfig = resolveWorkflowConfigValues(
      cwd,
      [
        'notificationSound',
        'notificationSoundEvents',
        'concurrency',
        'taskPollIntervalMs',
        'ignoreExceed',
        'autoRequeueMaxAttempts',
      ],
    );
    const runOptions = {
      ...(options?.ignoreExceed === true || globalConfig.ignoreExceed === true
        ? { ignoreIterationLimit: true }
        : {}),
      autoRequeueMaxAttempts: globalConfig.autoRequeueMaxAttempts,
    };
    const shouldNotifyRunComplete = globalConfig.notificationSound !== false
      && globalConfig.notificationSoundEvents?.runComplete !== false;
    const shouldNotifyRunAbort = globalConfig.notificationSound !== false
      && globalConfig.notificationSoundEvents?.runAbort !== false;
    const concurrency = globalConfig.concurrency;
    const slackWebhookUrl = getSlackWebhookUrl();
    const schedulingSignal = shutdownSignals.schedulingSignal;
    const retryLockTimeout = <T>(operation: () => T | Promise<T>) =>
      retryStartupLockTimeout(operation, globalConfig.taskPollIntervalMs, schedulingSignal);
    const failedInterrupted = await retryLockTimeout(() => failInterruptedTasksWithGoalEvents(taskRunner, cwd)) ?? 0;
    if (failedInterrupted > 0) {
      info(`Marked ${failedInterrupted} interrupted running task(s) as failed.`);
    }
    const confirmation = terminalProviderConfirmation();
    const pendingTasks = await retryLockTimeout(
      () => taskRunner.listTasksForProviderPreflight(),
    ) ?? [];
    const maxAttempts = runOptions.autoRequeueMaxAttempts;
    const failedTasks = maxAttempts > 0
      ? (await retryLockTimeout(() => taskRunner.listFailedTasks())) ?? [] : [];
    for (const task of pendingTasks) {
      if (shutdownSignals.schedulingSignal.aborted) break;
      if (task.data?.goal_id !== undefined
        && runtimeAssignmentUnavailableReason(cwd, task.data) !== undefined) continue;
      await checkQueuedTaskProviders(cwd, task, agentOverrides ?? {}, confirmation, shutdownSignals.schedulingSignal);
    }
    for (const task of failedTasks) {
      if (shutdownSignals.schedulingSignal.aborted) break;
      if (!await retryLockTimeout(() => isAutoRequeueCandidate(taskRunner, cwd, task.name, maxAttempts))) continue;
      await checkQueuedTaskProviders(cwd, task, agentOverrides ?? {}, confirmation, shutdownSignals.schedulingSignal);
    }
    let requeuedExistingFailed = 0;
    for (const task of failedTasks) {
      if (schedulingSignal.aborted) break;
      // Keep successful writes and provider checks completed when a later write needs a retry.
      if (await retryLockTimeout(() => attemptAutoRequeueTask(taskRunner, cwd, task.name, maxAttempts))) {
        requeuedExistingFailed++;
      }
    }
    if (requeuedExistingFailed > 0) {
      info(`Auto-requeued ${requeuedExistingFailed} existing failed task(s).`);
    }
    await retryLockTimeout(
      () => checkPendingTaskProviders(taskRunner, cwd, agentOverrides ?? {}, confirmation,
        pendingTasks, schedulingSignal),
    );

    const runId = generateRunId();
    const startTime = Date.now();

    let displayStarted = false;
    const poolSignals = {
      ...shutdownSignals,
      onTasksClaimed: () => {
        if (displayStarted) return;
        displayStarted = true;
        header('Running tasks');
        if (concurrency > 1) info(`Concurrency: ${concurrency}`);
        statusLine.start('Running tasks...');
      },
    };

    const sendSlackSummary = async (executedTaskNames: string[]): Promise<void> => {
      if (!slackWebhookUrl) return;
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      const executedSet = new Set(executedTaskNames);
      const tasks = taskRunner.listAllTaskItems()
        .filter((item) => executedSet.has(item.name))
        .map(toSlackTaskDetail);
      const successCount = tasks.filter((task) => task.success).length;
      const message = buildSlackRunSummary({
        runId,
        total: tasks.length,
        success: successCount,
        failed: tasks.length - successCount,
        durationSec,
        concurrency,
        tasks,
      });
      await sendSlackNotification(slackWebhookUrl, message);
    };

    try {
      const result = await runWithWorkerPool(
        taskRunner,
        [],
        concurrency,
        cwd,
        agentOverrides,
        runOptions,
        globalConfig.taskPollIntervalMs,
        'run',
        poolSignals,
      );

      const totalCount = result.success + result.fail;
      if (totalCount === 0) {
        info('No pending tasks in .takt/tasks.yaml');
        info('Use takt add to append tasks.');
        return;
      }
      blankLine();
      header('Tasks Summary');
      status('Total', String(totalCount));
      status('Success', String(result.success), result.success === totalCount ? 'green' : undefined);
      if (result.fail > 0) {
        status('Failed', String(result.fail), 'red');
        if (shouldNotifyRunAbort) {
          notifyError('TAKT', getLabel('run.notifyAbort', undefined, { failed: String(result.fail) }));
        }
        await sendSlackSummary(result.executedTaskNames);
        return;
      }

      if (shouldNotifyRunComplete) {
        notifySuccess('TAKT', getLabel('run.notifyComplete', undefined, { total: String(totalCount) }));
      }
      await sendSlackSummary(result.executedTaskNames);
    } catch (error) {
      if (shouldNotifyRunAbort) {
        notifyError('TAKT', getLabel('run.notifyAbort', undefined, { failed: getErrorMessage(error) }));
      }
      await sendSlackSummary([]);
      throw error;
    } finally {
      statusLine.stop();
    }
  });
}

async function retryStartupLockTimeout<T>(
  operation: () => T | Promise<T>,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<T | undefined> {
  let warned = false;
  while (!signal.aborted) {
    try {
      return await operation();
    } catch (error) {
      if (!isClaimLockTimeoutFailure(error)) throw error;
      if (!warned) {
        warn('Cannot prepare startup tasks because the task store lock is held. Waiting to retry.');
        warned = true;
      }
    }
    try {
      await delay(pollIntervalMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  return undefined;
}
