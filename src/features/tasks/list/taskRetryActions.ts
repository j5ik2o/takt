/**
 * Retry actions for failed tasks.
 *
 * Provides interactive retry functionality including
 * failure info display and movement selection.
 */

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner, parseTaskFile, type TaskFileData } from '../../../infra/task/index.js';
import { extractFailureInfo, type FailureInfo } from '../../../infra/fs/session.js';
import { loadPieceByIdentifier, loadGlobalConfig } from '../../../infra/config/index.js';
import { selectOption, promptInput } from '../../../shared/prompt/index.js';
import { success, error as logError, info, header, blankLine, status } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import type { PieceConfig } from '../../../core/models/index.js';

const log = createLogger('list-tasks');

/**
 * Find the session log file path from a failed task directory.
 * Looks in .takt/logs/ for a matching session ID from log.json.
 */
function findSessionLogPath(failedTaskDir: string, projectDir: string): string | null {
  const logsDir = join(projectDir, '.takt', 'logs');
  if (!existsSync(logsDir)) return null;

  // Try to find the log file
  // Failed tasks don't have sessionId in log.json by default,
  // so we look for the most recent log file that matches the failure time
  const logJsonPath = join(failedTaskDir, 'log.json');
  if (!existsSync(logJsonPath)) return null;

  try {
    // List all .jsonl files in logs dir
    const logFiles = readdirSync(logsDir).filter((f) => f.endsWith('.jsonl'));
    if (logFiles.length === 0) return null;

    // Get the failed task timestamp from directory name
    const dirName = failedTaskDir.split('/').pop();
    if (!dirName) return null;
    const underscoreIdx = dirName.indexOf('_');
    if (underscoreIdx === -1) return null;
    const timestampRaw = dirName.slice(0, underscoreIdx);
    // Convert format: 2026-01-31T12-00-00 -> 20260131-120000
    const normalizedTimestamp = timestampRaw
      .replace(/-/g, '')
      .replace('T', '-');

    // Find logs that match the date (first 8 chars of normalized timestamp)
    const datePrefix = normalizedTimestamp.slice(0, 8);
    const matchingLogs = logFiles
      .filter((f) => f.startsWith(datePrefix))
      .sort()
      .reverse(); // Most recent first

    // Return the most recent matching log
    if (matchingLogs.length > 0) {
      return join(logsDir, matchingLogs[0]!);
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * Find and parse the task file from a failed task directory.
 * Returns the parsed TaskFileData if found, null otherwise.
 */
function parseFailedTaskFile(failedTaskDir: string): TaskFileData | null {
  const taskExtensions = ['.yaml', '.yml', '.md'];
  let files: string[];
  try {
    files = readdirSync(failedTaskDir);
  } catch {
    return null;
  }

  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'));
    if (file === 'report.md' || file === 'log.json') continue;
    if (!taskExtensions.includes(ext)) continue;

    try {
      const taskFilePath = join(failedTaskDir, file);
      const parsed = parseTaskFile(taskFilePath);
      return parsed.data;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Display failure information for a failed task.
 */
function displayFailureInfo(task: TaskListItem, failureInfo: FailureInfo | null): void {
  header(`Failed Task: ${task.name}`);
  info(`  Failed at: ${task.createdAt}`);

  if (failureInfo) {
    blankLine();
    if (failureInfo.lastCompletedMovement) {
      status('Last completed', failureInfo.lastCompletedMovement);
    }
    if (failureInfo.failedMovement) {
      status('Failed at', failureInfo.failedMovement, 'red');
    }
    status('Iterations', String(failureInfo.iterations));
    if (failureInfo.errorMessage) {
      status('Error', failureInfo.errorMessage, 'red');
    }
  } else {
    blankLine();
    info('  (No session log found - failure details unavailable)');
  }
  blankLine();
}

/**
 * Prompt user to select a movement to start from.
 * Returns the selected movement name, or null if cancelled.
 */
async function selectStartMovement(
  pieceConfig: PieceConfig,
  defaultMovement: string | null,
): Promise<string | null> {
  const movements = pieceConfig.movements.map((m) => m.name);

  // Determine default selection
  const defaultIdx = defaultMovement
    ? movements.indexOf(defaultMovement)
    : 0;
  const effectiveDefault = defaultIdx >= 0 ? movements[defaultIdx] : movements[0];

  const options = movements.map((name) => ({
    label: name === effectiveDefault ? `${name} (default)` : name,
    value: name,
    description: name === pieceConfig.initialMovement ? 'Initial movement' : undefined,
  }));

  return await selectOption<string>('Start from movement:', options);
}

/**
 * Retry a failed task.
 * Shows failure info, prompts for movement selection, and requeues the task.
 *
 * @returns true if task was requeued, false if cancelled
 */
export async function retryFailedTask(
  task: TaskListItem,
  projectDir: string,
): Promise<boolean> {
  // Find session log and extract failure info
  const sessionLogPath = findSessionLogPath(task.filePath, projectDir);
  const failureInfo = sessionLogPath ? extractFailureInfo(sessionLogPath) : null;

  // Display failure information
  displayFailureInfo(task, failureInfo);

  // Parse the failed task file to get the piece field
  const taskFileData = parseFailedTaskFile(task.filePath);

  // Determine piece name: task file -> global config -> 'default'
  const globalConfig = loadGlobalConfig();
  const pieceName = taskFileData?.piece ?? globalConfig.defaultPiece ?? 'default';
  const pieceConfig = loadPieceByIdentifier(pieceName, projectDir);

  if (!pieceConfig) {
    logError(`Piece "${pieceName}" not found. Cannot determine available movements.`);
    return false;
  }

  // Prompt for movement selection
  // Default to failed movement, or last completed + 1, or initial movement
  let defaultMovement: string | null = null;
  if (failureInfo?.failedMovement) {
    defaultMovement = failureInfo.failedMovement;
  } else if (failureInfo?.lastCompletedMovement) {
    // Find the next movement after the last completed one
    const movements = pieceConfig.movements.map((m) => m.name);
    const lastIdx = movements.indexOf(failureInfo.lastCompletedMovement);
    if (lastIdx >= 0 && lastIdx < movements.length - 1) {
      defaultMovement = movements[lastIdx + 1] ?? null;
    }
  }

  const selectedMovement = await selectStartMovement(pieceConfig, defaultMovement);
  if (selectedMovement === null) {
    return false; // User cancelled
  }

  // Prompt for retry note (optional)
  blankLine();
  const retryNote = await promptInput('Retry note (optional, press Enter to skip):');
  const trimmedNote = retryNote?.trim();

  // Requeue the task
  try {
    const runner = new TaskRunner(projectDir);
    // Only pass startMovement if it's different from the initial movement
    const startMovement = selectedMovement !== pieceConfig.initialMovement
      ? selectedMovement
      : undefined;
    const requeuedPath = runner.requeueFailedTask(
      task.filePath,
      startMovement,
      trimmedNote || undefined
    );

    success(`Task requeued: ${task.name}`);
    if (startMovement) {
      info(`  Will start from: ${startMovement}`);
    }
    if (trimmedNote) {
      info(`  Retry note: ${trimmedNote}`);
    }
    info(`  Task file: ${requeuedPath}`);

    log.info('Requeued failed task', {
      name: task.name,
      from: task.filePath,
      to: requeuedPath,
      startMovement,
      retryNote: trimmedNote,
    });

    return true;
  } catch (err) {
    const msg = getErrorMessage(err);
    logError(`Failed to requeue task: ${msg}`);
    log.error('Failed to requeue task', { name: task.name, error: msg });
    return false;
  }
}
