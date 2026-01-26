/**
 * Instruction template builder for workflow steps
 *
 * Builds the instruction string for agent execution by replacing
 * template placeholders with actual values.
 */

import type { WorkflowStep, AgentResponse } from '../models/types.js';
import { getGitDiff } from '../agents/runner.js';

/**
 * Context for building instruction from template.
 */
export interface InstructionContext {
  /** The main task/prompt */
  task: string;
  /** Current iteration number */
  iteration: number;
  /** Maximum iterations allowed */
  maxIterations: number;
  /** Working directory */
  cwd: string;
  /** User inputs accumulated during workflow */
  userInputs: string[];
  /** Previous step output if available */
  previousOutput?: AgentResponse;
  /** Report directory path */
  reportDir?: string;
}

/**
 * Escape special characters in dynamic content to prevent template injection.
 */
function escapeTemplateChars(str: string): string {
  return str.replace(/\{/g, '｛').replace(/\}/g, '｝');
}

/**
 * Build instruction from template with context values.
 *
 * Supported placeholders:
 * - {task} - The main task/prompt
 * - {iteration} - Current iteration number
 * - {max_iterations} - Maximum iterations allowed
 * - {previous_response} - Output from previous step (if passPreviousResponse is true)
 * - {git_diff} - Current git diff output
 * - {user_inputs} - Accumulated user inputs
 * - {report_dir} - Report directory name (e.g., "20250126-143052-task-summary")
 */
export function buildInstruction(
  step: WorkflowStep,
  context: InstructionContext
): string {
  let instruction = step.instructionTemplate;

  // Replace {task}
  instruction = instruction.replace(/\{task\}/g, escapeTemplateChars(context.task));

  // Replace {iteration} and {max_iterations}
  instruction = instruction.replace(/\{iteration\}/g, String(context.iteration));
  instruction = instruction.replace(/\{max_iterations\}/g, String(context.maxIterations));

  // Replace {previous_response}
  if (step.passPreviousResponse) {
    if (context.previousOutput) {
      instruction = instruction.replace(
        /\{previous_response\}/g,
        escapeTemplateChars(context.previousOutput.content)
      );
    } else {
      instruction = instruction.replace(/\{previous_response\}/g, '');
    }
  }

  // Replace {git_diff}
  const gitDiff = getGitDiff(context.cwd);
  instruction = instruction.replace(/\{git_diff\}/g, gitDiff);

  // Replace {user_inputs}
  const userInputsStr = context.userInputs.join('\n');
  instruction = instruction.replace(
    /\{user_inputs\}/g,
    escapeTemplateChars(userInputsStr)
  );

  // Replace {report_dir}
  if (context.reportDir) {
    instruction = instruction.replace(/\{report_dir\}/g, context.reportDir);
  }

  // Append status_rules_prompt if present
  if (step.statusRulesPrompt) {
    instruction = `${instruction}\n\n${step.statusRulesPrompt}`;
  }

  return instruction;
}
