/**
 * Agent configuration loader
 *
 * Loads agents with user → builtin fallback:
 * 1. User agents: ~/.takt/agents/*.md
 * 2. Builtin agents: resources/global/{lang}/agents/*.md
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { CustomAgentConfig } from '../../../core/models/index.js';
import {
  getGlobalAgentsDir,
  getGlobalPiecesDir,
  getBuiltinAgentsDir,
  getBuiltinPiecesDir,
  isPathSafe,
} from '../paths.js';
import { getLanguage } from '../global/globalConfig.js';

/** Get all allowed base directories for agent prompt files */
function getAllowedAgentBases(): string[] {
  const lang = getLanguage();
  return [
    getGlobalAgentsDir(),
    getGlobalPiecesDir(),
    getBuiltinAgentsDir(lang),
    getBuiltinPiecesDir(lang),
  ];
}

/** Load agents from markdown files in a directory */
export function loadAgentsFromDir(dirPath: string): CustomAgentConfig[] {
  if (!existsSync(dirPath)) {
    return [];
  }
  const agents: CustomAgentConfig[] = [];
  for (const file of readdirSync(dirPath)) {
    if (file.endsWith('.md')) {
      const name = basename(file, '.md');
      const promptFile = join(dirPath, file);
      agents.push({
        name,
        promptFile,
      });
    }
  }
  return agents;
}

/** Load all custom agents from global directory (~/.takt/agents/) */
export function loadCustomAgents(): Map<string, CustomAgentConfig> {
  const agents = new Map<string, CustomAgentConfig>();

  // Global agents from markdown files (~/.takt/agents/*.md)
  for (const agent of loadAgentsFromDir(getGlobalAgentsDir())) {
    agents.set(agent.name, agent);
  }

  return agents;
}

/** List available custom agents */
export function listCustomAgents(): string[] {
  return Array.from(loadCustomAgents().keys()).sort();
}

/**
 * Load agent prompt content.
 * Agents can be loaded from:
 * - ~/.takt/agents/*.md (global agents)
 * - ~/.takt/pieces/{workflow}/*.md (workflow-specific agents)
 */
export function loadAgentPrompt(agent: CustomAgentConfig): string {
  if (agent.prompt) {
    return agent.prompt;
  }

  if (agent.promptFile) {
    const promptFile = agent.promptFile;
    const isValid = getAllowedAgentBases().some((base) => isPathSafe(base, promptFile));
    if (!isValid) {
      throw new Error(`Agent prompt file path is not allowed: ${agent.promptFile}`);
    }

    if (!existsSync(agent.promptFile)) {
      throw new Error(`Agent prompt file not found: ${agent.promptFile}`);
    }

    return readFileSync(agent.promptFile, 'utf-8');
  }

  throw new Error(`Agent ${agent.name} has no prompt defined`);
}

/**
 * Load agent prompt from a resolved path.
 * Used by workflow engine when agentPath is already resolved.
 */
export function loadAgentPromptFromPath(agentPath: string): string {
  const isValid = getAllowedAgentBases().some((base) => isPathSafe(base, agentPath));
  if (!isValid) {
    throw new Error(`Agent prompt file path is not allowed: ${agentPath}`);
  }

  if (!existsSync(agentPath)) {
    throw new Error(`Agent prompt file not found: ${agentPath}`);
  }

  return readFileSync(agentPath, 'utf-8');
}
