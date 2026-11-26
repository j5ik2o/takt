import type { AgentResponse } from '../models/types.js';
import { projectNativeStructuredOutputSchema } from '../models/native-structured-output-schema.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { sanitizeSensitiveValue } from '../../shared/utils/sensitive-value.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';
import { parseStructuredOutputObject } from '../../agents/structured-caller/shared.js';
import {
  StructuredAgentContractError,
  StructuredOutputRejectedError,
} from '../../agents/structured-caller/transport.js';
import { validateStructuredOutputAgainstSchema } from './engine/structured-output-schema-validator.js';

export interface SelectorCandidate {
  readonly name: string;
  readonly description: string;
}

export interface SelectorResponseLabel {
  readonly label: string;
}

export interface SelectorContract {
  readonly providerSchema: Record<string, unknown>;
  readonly validationSchema: Record<string, unknown>;
  readonly candidateIds: readonly string[];
}

export const SELECTOR_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const RETURNED_IDS_MAX_BYTES = 512;

export function buildSelectorGuidanceLines(selectorInstruction: string | undefined): readonly string[] {
  return selectorInstruction === undefined
    ? []
    : ['', `Selector guidance:\n${selectorInstruction}`];
}

export function createSelectorContract(
  candidates: readonly SelectorCandidate[],
  maxSelected?: number,
): SelectorContract {
  const candidateIds = candidates.map(({ name }) => name);
  const selectedIds: Record<string, unknown> = {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string', enum: candidateIds },
  };
  if (maxSelected !== undefined) selectedIds.maxItems = maxSelected;
  const validationSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    properties: {
      selected_ids: selectedIds,
      rationale: { type: 'string' },
    },
    required: ['selected_ids', 'rationale'],
  };
  return {
    providerSchema: projectNativeStructuredOutputSchema(validationSchema),
    validationSchema,
    candidateIds,
  };
}

type Redact = (text: string) => string;

function redactJson(value: unknown, redact: Redact): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactJson(item, redact)]));
  }
  return value;
}

/**
 * Masks whatever sits under a secret key, then redacts each string and key before encoding: an
 * escaped or shortened secret no longer matches its known value.
 */
function renderIds(ids: unknown, redact: Redact): string {
  return JSON.stringify(redactJson(sanitizeSensitiveValue(ids), redact));
}

function renderReturnedIds(returned: unknown, redact: Redact): string {
  const rendered = renderIds(returned, redact);
  const truncated = truncateUtf8(rendered, RETURNED_IDS_MAX_BYTES).value;
  return truncated === rendered ? rendered : `${truncated}... (truncated)`;
}

function invalidSelectorOutputMessage(
  detail: string,
  structuredOutput: Record<string, unknown> | undefined,
  contract: SelectorContract,
  stepName: string,
  redact: Redact,
  label: SelectorResponseLabel,
): string {
  const returned = structuredOutput?.selected_ids;
  return redact([
    `${label.label} selector for "${stepName}" returned invalid structured output: ${detail}`,
    ...(returned === undefined ? [] : [`returned selected_ids: ${renderReturnedIds(returned, redact)}`]),
    `allowed candidate ids: ${renderIds(contract.candidateIds, redact)}`,
  ].join('; '));
}

function rejectedStructuredOutput(response: AgentResponse): Record<string, unknown> | undefined {
  if (response.structuredOutput !== undefined) return response.structuredOutput;
  try {
    return parseStructuredOutputObject(response.content);
  } catch {
    return undefined;
  }
}

/**
 * The transport, or the provider itself, rejects an out-of-contract selection before
 * `validateSelectorResponse` runs, so its error names neither the selector nor the candidates.
 */
export function describeSelectorError(
  error: unknown,
  contract: SelectorContract,
  stepName: string,
  redact: Redact,
  label: SelectorResponseLabel,
): string {
  if (error instanceof StructuredOutputRejectedError) {
    return invalidSelectorOutputMessage(
      error.message,
      error.rejectedStructuredOutput,
      contract,
      stepName,
      redact,
      label,
    );
  }
  return error instanceof StructuredAgentContractError
    ? invalidSelectorOutputMessage(
      error.message,
      rejectedStructuredOutput(error.response),
      contract,
      stepName,
      redact,
      label,
    )
    : redact(getErrorMessage(error));
}

export function validateSelectorResponse(
  response: AgentResponse,
  contract: SelectorContract,
  stepName: string,
  redact: Redact,
  label: SelectorResponseLabel,
): { readonly selectedIds: readonly string[]; readonly rationale: string } {
  if (response.status !== 'done') {
    const category = response.failureCategory ?? response.errorKind;
    const detail = redact(response.error ?? response.content).trim();
    const diagnostics = [
      `status "${response.status}"`,
      ...(category === undefined ? [] : [`category "${category}"`]),
      ...(detail.length === 0 ? [] : [detail]),
    ].join(': ');
    throw new Error(`${label.label} selector for "${stepName}" failed with ${diagnostics}`);
  }
  try {
    validateStructuredOutputAgainstSchema(response.structuredOutput, contract.validationSchema);
  } catch (error) {
    throw new Error(invalidSelectorOutputMessage(
      getErrorMessage(error),
      response.structuredOutput,
      contract,
      stepName,
      redact,
      label,
    ));
  }
  const selection = response.structuredOutput as {
    readonly selected_ids: readonly string[];
    readonly rationale: string;
  };
  return {
    selectedIds: selection.selected_ids,
    rationale: redact(selection.rationale),
  };
}
