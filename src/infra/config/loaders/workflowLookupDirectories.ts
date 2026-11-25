import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkflowConfigValues } from '../resolveWorkflowConfigValue.js';
import {
  getBuiltinWorkflowsDir,
  getGlobalWorkflowsDir,
  getProjectWorkflowsDir,
  isPathSafe,
} from '../paths.js';
import { listBuiltinWorkflowNamesForDir, type WorkflowSource } from './workflowDiscovery.js';
import type { WorkflowTrustSource } from './workflowTrustSource.js';

interface WorkflowLookupDir {
  dir: string;
  source: WorkflowSource;
  disabled?: string[];
}

export interface NamedWorkflowLookupDir<Source extends WorkflowTrustSource = WorkflowTrustSource> {
  dir: string;
  source: Source;
  disabled?: string[];
}

export function resolveWorkflowFile(workflowsDir: string, name: string): string | null {
  const resolvedWorkflowsDir = resolve(workflowsDir);
  for (const ext of ['.yaml', '.yml']) {
    const filePath = resolve(workflowsDir, `${name}${ext}`);
    if (!isPathSafe(resolvedWorkflowsDir, filePath)) {
      continue;
    }
    if (existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

export function findWorkflowInLookupDirs<Source extends WorkflowTrustSource>(
  name: string,
  lookupDirs: NamedWorkflowLookupDir<Source>[],
): { filePath: string; source: Source } | null {
  for (const { dir, source, disabled } of lookupDirs) {
    if (source === 'builtin' && disabled?.includes(name)) {
      continue;
    }

    const filePath = resolveWorkflowFile(dir, name);
    if (!filePath) {
      continue;
    }

    return { filePath, source };
  }

  return null;
}

export function getWorkflowDirs(cwd: string): WorkflowLookupDir[] {
  const config = resolveWorkflowConfigValues(cwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const dirs: WorkflowLookupDir[] = [];

  if (config.enableBuiltinWorkflows !== false) {
    dirs.push({
      dir: getBuiltinWorkflowsDir(config.language),
      disabled: config.disabledBuiltins ?? [],
      source: 'builtin',
    });
  }

  dirs.push({ dir: getGlobalWorkflowsDir(), source: 'user' });
  dirs.push({ dir: getProjectWorkflowsDir(cwd), source: 'project' });
  return dirs;
}

type BuiltinExclusionReason =
  | { readonly kind: 'builtins_disabled' }
  | { readonly kind: 'builtin_listed_in_disabled'; readonly name: string };

interface NamedWorkflowLookupPlan {
  readonly lookupDirs: WorkflowLookupDir[];
  readonly builtinDir: string;
  readonly builtinExclusion?: BuiltinExclusionReason;
}

function buildNamedWorkflowLookupPlan(projectCwd: string, name?: string): NamedWorkflowLookupPlan {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  const builtinDir = getBuiltinWorkflowsDir(config.language);
  const disabledBuiltins = config.disabledBuiltins ?? [];
  const lookupDirs: WorkflowLookupDir[] = [
    {
      dir: resolve(getProjectWorkflowsDir(projectCwd)),
      source: 'project',
    },
    { dir: getGlobalWorkflowsDir(), source: 'user' },
  ];

  if (config.enableBuiltinWorkflows === false) {
    return {
      lookupDirs,
      builtinDir,
      builtinExclusion: { kind: 'builtins_disabled' },
    };
  }

  if (name !== undefined && disabledBuiltins.includes(name)) {
    return {
      lookupDirs,
      builtinDir,
      builtinExclusion: { kind: 'builtin_listed_in_disabled', name },
    };
  }

  lookupDirs.push({
    dir: builtinDir,
    disabled: disabledBuiltins,
    source: 'builtin',
  });
  return { lookupDirs, builtinDir };
}

export function getNamedWorkflowLookupDirs(projectCwd: string): WorkflowLookupDir[] {
  return buildNamedWorkflowLookupPlan(projectCwd).lookupDirs;
}

export interface NamedWorkflowLookupExplanation {
  readonly searched: readonly string[];
  readonly excluded: readonly string[];
}

/** Explains where a named workflow lookup looked and which candidates the configuration excluded. */
export function explainNamedWorkflowLookup(name: string, projectCwd: string): NamedWorkflowLookupExplanation {
  const plan = buildNamedWorkflowLookupPlan(projectCwd, name);
  const searched = plan.lookupDirs.map(({ dir, source }) => `${source}: ${resolve(dir, `${name}.yaml`)} (or .yml)`);
  const excluded: string[] = [];
  if (plan.builtinExclusion !== undefined) {
    const builtinPath = resolve(plan.builtinDir, `${name}.yaml`);
    const builtinExists = resolveWorkflowFile(plan.builtinDir, name) !== null;
    const builtinNote = builtinExists ? 'a builtin workflow with this name exists' : 'no builtin workflow has this name';
    const reason = plan.builtinExclusion.kind === 'builtins_disabled'
      ? 'enable_builtin_workflows is false'
      : `disabled_builtins lists "${plan.builtinExclusion.name}"`;
    excluded.push(`builtin: ${builtinPath} (excluded because ${reason}; ${builtinNote})`);
  }
  return { searched, excluded };
}

export function getBuiltinWorkflowPath(name: string, projectCwd: string): string | null {
  const config = resolveWorkflowConfigValues(projectCwd, ['enableBuiltinWorkflows', 'language', 'disabledBuiltins']);
  if (config.enableBuiltinWorkflows === false || (config.disabledBuiltins ?? []).includes(name)) {
    return null;
  }
  return resolveWorkflowFile(getBuiltinWorkflowsDir(config.language), name);
}

export function listBuiltinWorkflowNames(
  cwd: string,
  options?: { includeDisabled?: boolean },
): string[] {
  const config = resolveWorkflowConfigValues(cwd, ['language', 'disabledBuiltins']);
  const disabled = options?.includeDisabled ? undefined : (config.disabledBuiltins ?? []);
  return listBuiltinWorkflowNamesForDir(getBuiltinWorkflowsDir(config.language), disabled);
}
