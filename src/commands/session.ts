/**
 * Session management helpers for agent execution
 */

import { loadAgentSessions, updateAgentSession } from '../config/paths.js';
import { loadGlobalConfig } from '../config/globalConfig.js';
import type { AgentResponse } from '../models/types.js';

/**
 * Execute a function with agent session management.
 * Automatically loads existing session and saves updated session ID.
 */
export async function withAgentSession(
  cwd: string,
  agentName: string,
  fn: (sessionId?: string) => Promise<AgentResponse>,
  provider?: string
): Promise<AgentResponse> {
  const resolvedProvider = provider ?? loadGlobalConfig().provider ?? 'claude';
  const sessions = loadAgentSessions(cwd, resolvedProvider);
  const sessionId = sessions[agentName];

  const result = await fn(sessionId);

  if (result.sessionId) {
    updateAgentSession(cwd, agentName, result.sessionId, resolvedProvider);
  }

  return result;
}
