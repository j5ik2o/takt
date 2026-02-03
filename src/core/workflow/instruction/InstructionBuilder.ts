/**
 * Phase 1 instruction builder
 *
 * Builds the instruction string for main agent execution.
 * Assembles template variables and renders a single complete template.
 */

import type { WorkflowMovement, Language, ReportConfig, ReportObjectConfig } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { buildEditRule } from './instruction-context.js';
import { escapeTemplateChars, replaceTemplatePlaceholders } from './escape.js';
import { loadTemplate } from '../../../shared/prompts/index.js';

/**
 * Check if a report config is the object form (ReportObjectConfig).
 */
export function isReportObjectConfig(report: string | ReportConfig[] | ReportObjectConfig): report is ReportObjectConfig {
  return typeof report === 'object' && !Array.isArray(report) && 'name' in report;
}

/**
 * Builds Phase 1 instructions for agent execution.
 *
 * Stateless builder — all data is passed via constructor context.
 * Renders a single complete template with all variables.
 */
export class InstructionBuilder {
  constructor(
    private readonly step: WorkflowMovement,
    private readonly context: InstructionContext,
  ) {}

  /**
   * Build the complete instruction string.
   *
   * Assembles all template variables and renders the Phase 1 template
   * in a single loadTemplate() call.
   */
  build(): string {
    const language = this.context.language ?? 'en';

    // Execution context variables
    const editRule = buildEditRule(this.step.edit, language);

    // Workflow structure (loop expansion done in code)
    const workflowStructure = this.buildWorkflowStructure(language);

    // Report info
    const hasReport = !!(this.step.report && this.context.reportDir);
    let reportInfo = '';
    let phaseNote = '';
    if (hasReport && this.step.report && this.context.reportDir) {
      reportInfo = renderReportContext(this.step.report, this.context.reportDir);
      phaseNote = language === 'ja'
        ? '**注意:** これはPhase 1（本来の作業）です。作業完了後、Phase 2で自動的にレポートを生成します。'
        : '**Note:** This is Phase 1 (main work). After you complete your work, Phase 2 will automatically generate the report based on your findings.';
    }

    // Skip auto-injection for sections whose placeholders exist in the template
    const tmpl = this.step.instructionTemplate;
    const hasTaskPlaceholder = tmpl.includes('{task}');
    const hasPreviousResponsePlaceholder = tmpl.includes('{previous_response}');
    const hasUserInputsPlaceholder = tmpl.includes('{user_inputs}');

    // User Request
    const hasTaskSection = !hasTaskPlaceholder;
    const userRequest = hasTaskSection ? escapeTemplateChars(this.context.task) : '';

    // Previous Response
    const hasPreviousResponse = !!(
      this.step.passPreviousResponse &&
      this.context.previousOutput &&
      !hasPreviousResponsePlaceholder
    );
    const previousResponse = hasPreviousResponse && this.context.previousOutput
      ? escapeTemplateChars(this.context.previousOutput.content)
      : '';

    // User Inputs
    const hasUserInputs = !hasUserInputsPlaceholder;
    const userInputs = hasUserInputs
      ? escapeTemplateChars(this.context.userInputs.join('\n'))
      : '';

    // Instructions (instruction_template processed)
    const instructions = replaceTemplatePlaceholders(
      this.step.instructionTemplate,
      this.step,
      this.context,
    );

    return loadTemplate('perform_phase1_message', language, {
      workingDirectory: this.context.cwd,
      editRule,
      workflowStructure,
      iteration: `${this.context.iteration}/${this.context.maxIterations}`,
      movementIteration: String(this.context.movementIteration),
      movement: this.step.name,
      hasReport,
      reportInfo,
      phaseNote,
      hasTaskSection,
      userRequest,
      hasPreviousResponse,
      previousResponse,
      hasUserInputs,
      userInputs,
      instructions,
    });
  }

  /**
   * Build the workflow structure display string.
   * Returns empty string if no workflow movements are available.
   */
  private buildWorkflowStructure(language: Language): string {
    if (!this.context.workflowMovements || this.context.workflowMovements.length === 0) {
      return '';
    }

    const currentMovementMarker = language === 'ja' ? '現在' : 'current';
    const structureHeader = language === 'ja'
      ? `このワークフローは${this.context.workflowMovements.length}ムーブメントで構成されています:`
      : `This workflow consists of ${this.context.workflowMovements.length} movements:`;
    const movementLines = this.context.workflowMovements.map((ws, index) => {
      const isCurrent = index === this.context.currentMovementIndex;
      const marker = isCurrent ? ` ← ${currentMovementMarker}` : '';
      const desc = ws.description ? `（${ws.description}）` : '';
      return `- Movement ${index + 1}: ${ws.name}${desc}${marker}`;
    });
    return [structureHeader, ...movementLines].join('\n');
  }
}

/**
 * Render report context info for Workflow Context section.
 * Used by InstructionBuilder and ReportInstructionBuilder.
 */
export function renderReportContext(
  report: string | ReportConfig[] | ReportObjectConfig,
  reportDir: string,
): string {
  const reportDirectory = 'Report Directory';
  const reportFile = 'Report File';
  const reportFiles = 'Report Files';

  const lines: string[] = [
    `- ${reportDirectory}: ${reportDir}/`,
  ];

  if (typeof report === 'string') {
    lines.push(`- ${reportFile}: ${reportDir}/${report}`);
  } else if (isReportObjectConfig(report)) {
    lines.push(`- ${reportFile}: ${reportDir}/${report.name}`);
  } else {
    lines.push(`- ${reportFiles}:`);
    for (const file of report) {
      lines.push(`  - ${file.label}: ${reportDir}/${file.path}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate report output instructions from movement's report config.
 * Returns empty string if movement has no report or no reportDir.
 */
export function renderReportOutputInstruction(
  step: WorkflowMovement,
  context: InstructionContext,
  language: Language,
): string {
  if (!step.report || !context.reportDir) return '';

  const isMulti = Array.isArray(step.report);

  let heading: string;
  let createRule: string;
  let appendRule: string;

  if (language === 'ja') {
    heading = isMulti
      ? '**レポート出力:** Report Files に出力してください。'
      : '**レポート出力:** `Report File` に出力してください。';
    createRule = '- ファイルが存在しない場合: 新規作成';
    appendRule = `- ファイルが存在する場合: \`## Iteration ${context.movementIteration}\` セクションを追記`;
  } else {
    heading = isMulti
      ? '**Report output:** Output to the `Report Files` specified above.'
      : '**Report output:** Output to the `Report File` specified above.';
    createRule = '- If file does not exist: Create new file';
    appendRule = `- If file exists: Append with \`## Iteration ${context.movementIteration}\` section`;
  }

  return `${heading}\n${createRule}\n${appendRule}`;
}
