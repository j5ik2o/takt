import { getGlobalConfigDir, getProjectConfigDir } from '../../../infra/config/paths.js';
import {
  getInvocationRuntimeAssignmentOverride,
  resolveInvocationRuntimeProviderFileWithOrigins,
  withTaskRuntimeAssignment,
} from '../../../infra/config/runtime-provider/invocation.js';
import { RuntimeAssignmentSelectionError } from '../../../infra/config/runtime-provider/loader.js';

/**
 * タスク自身の runtime_assignment を選択できないときだけ、選択エラーの文面を返す。
 * 名前が runtime.yaml から消えている場合と、名前は定義済みで provider section が無効な場合がある。
 *
 * goal の判定は呼び出し側が行う。provider.defaults.assignment や provider.directories の
 * 参照不正は別文面・別経路のため判定しない。`--runtime-assignment` 起動時はタスク名が解決に
 * 使われないため判定しない（invocation 側の既存優先順位に従う）。
 */
export function runtimeAssignmentUnavailableReason(
  cwd: string,
  data: { readonly runtime_assignment?: string } | null | undefined,
): string | undefined {
  const assignment = data?.runtime_assignment;
  if (assignment === undefined || getInvocationRuntimeAssignmentOverride() !== undefined) return undefined;
  try {
    withTaskRuntimeAssignment(assignment, () => resolveInvocationRuntimeProviderFileWithOrigins({
      globalConfigDir: getGlobalConfigDir(),
      projectConfigDir: getProjectConfigDir(cwd),
    }));
  } catch (error) {
    if (error instanceof RuntimeAssignmentSelectionError && error.assignmentName === assignment) {
      return error.message;
    }
    return undefined;
  }
  return undefined;
}
