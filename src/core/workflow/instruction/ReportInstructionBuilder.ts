/**
 * Phase 2 instruction builder (report output)
 *
 * Builds the instruction for the report output phase.
 * Assembles template variables and renders a single complete template.
 */

import type { WorkflowMovement, Language } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { replaceTemplatePlaceholders } from './escape.js';
import { isReportObjectConfig, renderReportContext, renderReportOutputInstruction } from './InstructionBuilder.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

/**
 * Context for building report phase instruction.
 */
export interface ReportInstructionContext {
  /** Working directory */
  cwd: string;
  /** Report directory path */
  reportDir: string;
  /** Movement iteration (for {step_iteration} replacement) */
  movementIteration: number;
  /** Language */
  language?: Language;
  /** Target report file name (when generating a single report) */
  targetFile?: string;
}

/**
 * Builds Phase 2 (report output) instructions.
 *
 * Renders a single complete template with all variables.
 */
export class ReportInstructionBuilder {
  constructor(
    private readonly step: WorkflowMovement,
    private readonly context: ReportInstructionContext,
  ) {}

  build(): string {
    if (!this.step.report) {
      throw new Error(`ReportInstructionBuilder called for movement "${this.step.name}" which has no report config`);
    }

    const language = this.context.language ?? 'en';

    // Build report context for Workflow Context section
    let reportContext: string;
    if (this.context.targetFile) {
      reportContext = `- Report Directory: ${this.context.reportDir}/\n- Report File: ${this.context.reportDir}/${this.context.targetFile}`;
    } else {
      reportContext = renderReportContext(this.step.report, this.context.reportDir);
    }

    // Build report output instruction
    let reportOutput = '';
    let hasReportOutput = false;
    const instrContext: InstructionContext = {
      task: '',
      iteration: 0,
      maxIterations: 0,
      movementIteration: this.context.movementIteration,
      cwd: this.context.cwd,
      projectCwd: this.context.cwd,
      userInputs: [],
      reportDir: this.context.reportDir,
      language,
    };

    if (isReportObjectConfig(this.step.report) && this.step.report.order) {
      reportOutput = replaceTemplatePlaceholders(this.step.report.order.trimEnd(), this.step, instrContext);
      hasReportOutput = true;
    } else if (!this.context.targetFile) {
      const output = renderReportOutputInstruction(this.step, instrContext, language);
      if (output) {
        reportOutput = output;
        hasReportOutput = true;
      }
    }

    // Build report format
    let reportFormat = '';
    let hasReportFormat = false;
    if (isReportObjectConfig(this.step.report) && this.step.report.format) {
      reportFormat = replaceTemplatePlaceholders(this.step.report.format.trimEnd(), this.step, instrContext);
      hasReportFormat = true;
    }

    return loadTemplate('perform_phase2_message', language, {
      workingDirectory: this.context.cwd,
      reportContext,
      hasReportOutput,
      reportOutput,
      hasReportFormat,
      reportFormat,
    });
  }
}
