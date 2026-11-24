import type { TaskInfo } from './types.js';

/**
 * goal タスクを実行へ渡す直前に、実行できない理由を照会するポート。
 * 理由を返すと、そのタスクは実行されず失敗として保存される。
 */
export interface GoalTaskSetupGuard {
  setupFailureReason(task: TaskInfo): string | undefined;
}
