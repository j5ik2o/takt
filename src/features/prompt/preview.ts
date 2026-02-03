/**
 * Prompt preview feature
 *
 * Loads a workflow and displays the assembled prompt for each movement and phase.
 * Useful for debugging and understanding what prompts agents will receive.
 */

import { loadWorkflowByIdentifier, getCurrentWorkflow, loadGlobalConfig } from '../../infra/config/index.js';
import { InstructionBuilder } from '../../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../../core/workflow/instruction/StatusJudgmentBuilder.js';
import { needsStatusJudgmentPhase } from '../../core/workflow/index.js';
import type { InstructionContext } from '../../core/workflow/instruction/instruction-context.js';
import type { Language } from '../../core/models/types.js';
import { header, info, error, blankLine } from '../../shared/ui/index.js';

/**
 * Preview all prompts for a workflow.
 *
 * Loads the workflow definition, then for each movement builds and displays
 * the Phase 1, Phase 2, and Phase 3 prompts with sample variable values.
 */
export async function previewPrompts(cwd: string, workflowIdentifier?: string): Promise<void> {
  const identifier = workflowIdentifier ?? getCurrentWorkflow(cwd);
  const config = loadWorkflowByIdentifier(identifier, cwd);

  if (!config) {
    error(`Workflow "${identifier}" not found.`);
    return;
  }

  const globalConfig = loadGlobalConfig();
  const language: Language = globalConfig.language ?? 'en';

  header(`Prompt Preview: ${config.name}`);
  info(`Movements: ${config.movements.length}`);
  info(`Language: ${language}`);
  blankLine();

  for (const [i, movement] of config.movements.entries()) {
    const separator = '='.repeat(60);

    console.log(separator);
    console.log(`Movement ${i + 1}: ${movement.name} (agent: ${movement.agentDisplayName})`);
    console.log(separator);

    // Phase 1: Main execution
    const context: InstructionContext = {
      task: '<task content>',
      iteration: 1,
      maxIterations: config.maxIterations,
      movementIteration: 1,
      cwd,
      projectCwd: cwd,
      userInputs: [],
      workflowMovements: config.movements,
      currentMovementIndex: i,
      reportDir: movement.report ? '.takt/reports/preview' : undefined,
      language,
    };

    const phase1Builder = new InstructionBuilder(movement, context);
    console.log('\n--- Phase 1 (Main Execution) ---\n');
    console.log(phase1Builder.build());

    // Phase 2: Report output (only if movement has report config)
    if (movement.report) {
      const reportBuilder = new ReportInstructionBuilder(movement, {
        cwd,
        reportDir: '.takt/reports/preview',
        movementIteration: 1,
        language,
      });
      console.log('\n--- Phase 2 (Report Output) ---\n');
      console.log(reportBuilder.build());
    }

    // Phase 3: Status judgment (only if movement has tag-based rules)
    if (needsStatusJudgmentPhase(movement)) {
      const judgmentBuilder = new StatusJudgmentBuilder(movement, { language });
      console.log('\n--- Phase 3 (Status Judgment) ---\n');
      console.log(judgmentBuilder.build());
    }

    blankLine();
  }
}
