/**
 * CLI subcommand definitions
 *
 * Registers all named subcommands (run, watch, add, list, switch, clear, eject, config, prompt).
 */

import { clearAgentSessions, getCurrentWorkflow } from '../../infra/config/index.js';
import { success } from '../../shared/ui/index.js';
import { runAllTasks, addTask, watchTasks, listTasks } from '../../features/tasks/index.js';
import { switchWorkflow, switchConfig, ejectBuiltin } from '../../features/config/index.js';
import { previewPrompts } from '../../features/prompt/index.js';
import { program, resolvedCwd } from './program.js';
import { resolveAgentOverrides } from './helpers.js';

program
  .command('run')
  .description('Run all pending tasks from .takt/tasks/')
  .action(async () => {
    const workflow = getCurrentWorkflow(resolvedCwd);
    await runAllTasks(resolvedCwd, workflow, resolveAgentOverrides(program));
  });

program
  .command('watch')
  .description('Watch for tasks and auto-execute')
  .action(async () => {
    await watchTasks(resolvedCwd, resolveAgentOverrides(program));
  });

program
  .command('add')
  .description('Add a new task (interactive AI conversation)')
  .argument('[task]', 'Task description or GitHub issue reference (e.g. "#28")')
  .action(async (task?: string) => {
    await addTask(resolvedCwd, task);
  });

program
  .command('list')
  .description('List task branches (merge/delete)')
  .action(async () => {
    await listTasks(resolvedCwd, resolveAgentOverrides(program));
  });

program
  .command('switch')
  .description('Switch workflow interactively')
  .argument('[workflow]', 'Workflow name')
  .action(async (workflow?: string) => {
    await switchWorkflow(resolvedCwd, workflow);
  });

program
  .command('clear')
  .description('Clear agent conversation sessions')
  .action(() => {
    clearAgentSessions(resolvedCwd);
    success('Agent sessions cleared');
  });

program
  .command('eject')
  .description('Copy builtin workflow/agents to ~/.takt/ for customization')
  .argument('[name]', 'Specific builtin to eject')
  .action(async (name?: string) => {
    await ejectBuiltin(name);
  });

program
  .command('config')
  .description('Configure settings (permission mode)')
  .argument('[key]', 'Configuration key')
  .action(async (key?: string) => {
    await switchConfig(resolvedCwd, key);
  });

program
  .command('prompt')
  .description('Preview assembled prompts for each movement and phase')
  .argument('[workflow]', 'Workflow name or path (defaults to current)')
  .action(async (workflow?: string) => {
    await previewPrompts(resolvedCwd, workflow);
  });
