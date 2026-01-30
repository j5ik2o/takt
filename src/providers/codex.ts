/**
 * Codex provider implementation
 */

import { callCodex, callCodexCustom, type CodexCallOptions } from '../codex/client.js';
import type { AgentResponse } from '../models/types.js';
import type { Provider, ProviderCallOptions } from './index.js';

/** Codex provider - wraps existing Codex client */
export class CodexProvider implements Provider {
  async call(agentName: string, prompt: string, options: ProviderCallOptions): Promise<AgentResponse> {
    const callOptions: CodexCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      systemPrompt: options.systemPrompt,
      onStream: options.onStream,
    };

    return callCodex(agentName, prompt, callOptions);
  }

  async callCustom(agentName: string, prompt: string, systemPrompt: string, options: ProviderCallOptions): Promise<AgentResponse> {
    const callOptions: CodexCallOptions = {
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      onStream: options.onStream,
    };

    return callCodexCustom(agentName, prompt, systemPrompt, callOptions);
  }
}
