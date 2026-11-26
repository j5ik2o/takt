import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { GoalQuestion } from '../../../infra/goals/schema.js';
import { parseInquiryFile, type InvalidInquiryFileReports } from '../../../infra/goals/inquiry-files.js';
import type { WatchGoalReader, WatchGoal } from './goalReader.js';
import { isMissing, listWatchEntries } from './files.js';
import { watchGoalDirectory } from './goalPaths.js';

export { readWatchTasks, TASKS_FILE_NAME, type WatchTask } from '../../../infra/task/taskStateReader.js';

export async function readWatchGoal(cwd: string, id: string, reader: WatchGoalReader): Promise<WatchGoal> {
  return reader.read(cwd, id);
}

export async function* readWatchGoals(cwd: string, onError: (error: unknown) => void, reader: WatchGoalReader): AsyncGenerator<WatchGoal> {
  let entries;
  try { entries = await listWatchEntries(await watchGoalDirectory(cwd)); }
  catch (error) { if (isMissing(error)) return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !z.uuid().safeParse(entry.name).success) continue;
    let goal;
    try { goal = await readWatchGoal(cwd, entry.name, reader); }
    catch (error) {
      // 列挙のあとに削除されたゴールは、読み取りの失敗ではなく無いものとして扱う。
      if (!isMissing(error)) onError(error);
      continue;
    }
    yield goal;
  }
}

/** 読めない 1 件は reports へ知らせて飛ばし、残りの問い合わせを返し続ける。 */
export async function* readWatchInquiries(directory: string, reports: InvalidInquiryFileReports): AsyncGenerator<GoalQuestion> {
  for (const entry of await listWatchEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(directory, entry.name);
    let question;
    try { question = parseInquiryFile(entry.name, JSON.parse(await readFile(path, 'utf8')) as unknown); }
    catch (error) {
      await reports.invalid(path, error);
      continue;
    }
    reports.valid(path);
    yield question;
  }
}
