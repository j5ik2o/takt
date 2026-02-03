/**
 * Phase 3 instruction builder (status judgment)
 *
 * Resumes the agent session and asks it to evaluate its work
 * and output the appropriate status tag. No tools are allowed.
 *
 * Renders a single complete template combining the judgment header
 * and status rules (criteria table + output format).
 */

import type { WorkflowMovement, Language } from '../../models/types.js';
import { generateStatusRulesComponents } from './status-rules.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

/**
 * Context for building status judgment instruction.
 */
export interface StatusJudgmentContext {
  /** Language */
  language?: Language;
  /** Whether interactive-only rules are enabled */
  interactive?: boolean;
}

/**
 * Builds Phase 3 (status judgment) instructions.
 *
 * Renders a single complete template with all variables.
 */
export class StatusJudgmentBuilder {
  constructor(
    private readonly step: WorkflowMovement,
    private readonly context: StatusJudgmentContext,
  ) {}

  build(): string {
    if (!this.step.rules || this.step.rules.length === 0) {
      throw new Error(`StatusJudgmentBuilder called for movement "${this.step.name}" which has no rules`);
    }

    const language = this.context.language ?? 'en';

    const components = generateStatusRulesComponents(
      this.step.name,
      this.step.rules,
      language,
      { interactive: this.context.interactive },
    );

    return loadTemplate('perform_phase3_message', language, {
      criteriaTable: components.criteriaTable,
      outputList: components.outputList,
      hasAppendix: components.hasAppendix,
      appendixContent: components.appendixContent,
    });
  }
}
