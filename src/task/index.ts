/**
 * Task execution module
 */

export {
  TaskRunner,
  type TaskInfo,
  type TaskResult,
} from './runner.js';

export { showTaskList } from './display.js';

export { TaskFileSchema, type TaskFileData } from './schema.js';
export { parseTaskFile, parseTaskFiles, type ParsedTask } from './parser.js';
export {
  createSharedClone,
  removeClone,
  createTempCloneForBranch,
  saveCloneMeta,
  removeCloneMeta,
  cleanupOrphanedClone,
  type WorktreeOptions,
  type WorktreeResult,
} from './clone.js';
export {
  detectDefaultBranch,
  listTaktBranches,
  parseTaktBranches,
  getFilesChanged,
  extractTaskSlug,
  getOriginalInstruction,
  buildListItems,
  type BranchInfo,
  type BranchListItem,
} from './branchList.js';
export { autoCommitAndPush, type AutoCommitResult } from './autoCommit.js';
export { TaskWatcher, type TaskWatcherOptions } from './watcher.js';
