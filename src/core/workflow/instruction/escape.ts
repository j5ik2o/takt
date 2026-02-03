/**
 * Template escaping and placeholder replacement utilities
 *
 * Used by instruction builders to process instruction_template content.
 */

import type { WorkflowMovement } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';

/**
 * Escape special characters in dynamic content to prevent template injection.
 */
export function escapeTemplateChars(str: string): string {
  return str.replace(/\{/g, '｛').replace(/\}/g, '｝');
}

/**
 * Replace template placeholders in the instruction_template body.
 *
 * These placeholders may still be used in instruction_template for
 * backward compatibility or special cases.
 */
export function replaceTemplatePlaceholders(
  template: string,
  step: WorkflowMovement,
  context: InstructionContext,
): string {
  let result = template;

  // Replace {task}
  result = result.replace(/\{task\}/g, escapeTemplateChars(context.task));

  // Replace {iteration}, {max_iterations}, and {movement_iteration}
  result = result.replace(/\{iteration\}/g, String(context.iteration));
  result = result.replace(/\{max_iterations\}/g, String(context.maxIterations));
  result = result.replace(/\{movement_iteration\}/g, String(context.movementIteration));
  // @deprecated Use {movement_iteration} instead
  result = result.replace(/\{step_iteration\}/g, String(context.movementIteration));

  // Replace {previous_response}
  if (step.passPreviousResponse) {
    if (context.previousOutput) {
      result = result.replace(
        /\{previous_response\}/g,
        escapeTemplateChars(context.previousOutput.content),
      );
    } else {
      result = result.replace(/\{previous_response\}/g, '');
    }
  }

  // Replace {user_inputs}
  const userInputsStr = context.userInputs.join('\n');
  result = result.replace(
    /\{user_inputs\}/g,
    escapeTemplateChars(userInputsStr),
  );

  // Replace {report_dir}
  if (context.reportDir) {
    result = result.replace(/\{report_dir\}/g, context.reportDir);
  }

  // Replace {report:filename} with reportDir/filename
  if (context.reportDir) {
    result = result.replace(/\{report:([^}]+)\}/g, (_match, filename: string) => {
      return `${context.reportDir}/${filename}`;
    });
  }

  return result;
}
