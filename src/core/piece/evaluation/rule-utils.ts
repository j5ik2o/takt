/**
 * Shared rule utility functions used by both engine.ts and instruction-builder.ts.
 */

import type { PieceMovement, OutputContractEntry } from '../../models/types.js';
import { isOutputContractItem } from '../instruction/InstructionBuilder.js';

/**
 * Check whether a movement has tag-based rules (i.e., rules that require
 * [MOVEMENT:N] tag output for detection).
 *
 * Returns false when all rules are ai() or aggregate conditions,
 * meaning no tag-based status output is needed.
 */
export function hasTagBasedRules(step: PieceMovement): boolean {
  if (!step.rules || step.rules.length === 0) return false;
  const allNonTagConditions = step.rules.every((r) => r.isAiCondition || r.isAggregateCondition);
  return !allNonTagConditions;
}

/**
 * Check if a movement has only one branch (automatic selection possible).
 * Returns true when rules.length === 1, meaning no actual choice is needed.
 */
export function hasOnlyOneBranch(step: PieceMovement): boolean {
  return step.rules !== undefined && step.rules.length === 1;
}

/**
 * Get the auto-selected tag when there's only one branch.
 * Returns the tag for the first rule (e.g., "[MOVEMENT:1]").
 */
export function getAutoSelectedTag(step: PieceMovement): string {
  if (!hasOnlyOneBranch(step)) {
    throw new Error('Cannot auto-select tag when multiple branches exist');
  }
  return `[${step.name.toUpperCase()}:1]`;
}

/**
 * Get report file names from a movement's output contracts.
 */
export function getReportFiles(outputContracts: OutputContractEntry[] | undefined): string[] {
  if (!outputContracts || outputContracts.length === 0) return [];
  return outputContracts.map((entry) => {
    if (isOutputContractItem(entry)) return entry.name;
    return entry.path;
  });
}
