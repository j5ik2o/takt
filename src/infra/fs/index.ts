/**
 * Filesystem utilities - barrel exports
 */

export type {
  SessionLog,
  NdjsonWorkflowStart,
  NdjsonStepStart,
  NdjsonStepComplete,
  NdjsonWorkflowComplete,
  NdjsonWorkflowAbort,
  NdjsonPhaseStart,
  NdjsonPhaseComplete,
  NdjsonInteractiveStart,
  NdjsonInteractiveEnd,
  NdjsonRecord,
  LatestLogPointer,
} from './session.js';

export {
  SessionManager,
  appendNdjsonLine,
  initNdjsonLog,
  loadNdjsonLog,
  generateSessionId,
  generateReportDir,
  createSessionLog,
  finalizeSessionLog,
  loadSessionLog,
  loadProjectContext,
  updateLatestPointer,
} from './session.js';
