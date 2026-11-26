import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, updateIsolatedConfig, type IsolatedEnv } from '../helpers/isolated-env.js';
import { createOfflineTestRepo, type TestRepo } from '../helpers/test-repo.js';
import { runTakt } from '../helpers/takt-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function writeAgent(baseDir: string): void {
  const agentsDir = join(baseDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, 'test-coder.md'),
    'You are a test coder. Complete the task exactly and respond with Done.',
    'utf-8',
  );
}

function writeMinimalWorkflow(workflowPath: string, stepName = 'execute'): void {
  const workflowDir = dirname(workflowPath);
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    workflowPath,
    [
      'name: e2e-branch-workflow',
      'description: Workflow for branch coverage E2E',
      'max_steps: 3',
      'steps:',
      `  - name: ${stepName}`,
      '    edit: true',
      '    persona: ../agents/test-coder.md',
      '    capabilities: edit',
      '    required_permission_mode: edit',
      '    instruction: |',
      '      {task}',
      '    rules:',
      '      - condition: Done',
      '        next: COMPLETE',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function runTaskWithSelection(args: {
  workflow?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ReturnType<typeof runTakt> {
  const scenarioPath = resolve(__dirname, '../fixtures/scenarios/execute-done.json');
  const baseArgs = ['--task', 'Create a file called noop.txt', '--provider', 'mock'];
  return runTakt({
    args: args.workflow ? [...baseArgs, '--workflow', args.workflow] : baseArgs,
    cwd: args.cwd,
    env: {
      ...args.env,
      TAKT_MOCK_SCENARIO: scenarioPath,
    },
    timeout: 240_000,
  });
}

describe('E2E: Workflow selection branch coverage', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createOfflineTestRepo();

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-model',
      enable_builtin_workflows: false,
    });
  });

  afterEach(() => {
    try {
      testRepo.cleanup();
    } catch {
      // best-effort
    }
    try {
      isolatedEnv.cleanup();
    } catch {
      // best-effort
    }
  });

  it('should execute when --workflow is a file path (isWorkflowPath branch)', () => {
    const customWorkflowPath = join(testRepo.path, '.takt', 'workflows', 'path-workflow.yaml');
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(customWorkflowPath);

    const result = runTaskWithSelection({
      workflow: customWorkflowPath,
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
  }, 240_000);

  it('should execute when --workflow is a known local name (resolver hit branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', 'workflows', 'local-workflow.yaml'));

    const result = runTaskWithSelection({
      workflow: 'local-workflow',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
  }, 240_000);

  it('should execute when --workflow is a repertoire @scope name (resolver hit branch)', () => {
    const pkgRoot = join(isolatedEnv.taktDir, 'repertoire', '@nrslib', 'takt-ensembles');
    writeAgent(pkgRoot);
    writeMinimalWorkflow(join(pkgRoot, 'workflows', 'critical-thinking.yaml'));

    const result = runTaskWithSelection({
      workflow: '@nrslib/takt-ensembles/critical-thinking',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
  }, 240_000);

  it('should execute when --workflow is omitted (workflow selection branch)', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', 'workflows', 'default.yaml'));

    const result = runTaskWithSelection({
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });
    expect(result.exitCode).toBe(0);
  }, 240_000);

  it('should execute successfully when --workflow is a known local name', () => {
    writeAgent(join(testRepo.path, '.takt'));
    writeMinimalWorkflow(join(testRepo.path, '.takt', 'workflows', 'canonical-workflow.yaml'));

    const result = runTaskWithSelection({
      workflow: 'canonical-workflow',
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });

    expect(result.exitCode).toBe(0);
  }, 240_000);

  describe('workflow_call to a builtin while builtin workflows are disabled', () => {
    function writeBuiltinCaller(): void {
      const workflowPath = join(testRepo.path, '.takt', 'workflows', 'builtin-caller.yaml');
      mkdirSync(dirname(workflowPath), { recursive: true });
      writeFileSync(
        workflowPath,
        [
          'name: builtin-caller',
          'initial_step: develop',
          'max_steps: 3',
          'steps:',
          '  - name: develop',
          '    kind: workflow_call',
          '    call: development-core',
          '    rules:',
          '      - condition: COMPLETE',
          '        next: COMPLETE',
          '      - condition: ABORT',
          '        next: ABORT',
          '',
        ].join('\n'),
        'utf-8',
      );
    }

    it('fails with the lookup reason and still records the run', () => {
      writeBuiltinCaller();

      const result = runTaskWithSelection({
        workflow: 'builtin-caller',
        cwd: testRepo.path,
        env: isolatedEnv.env,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const candidatePath = join(testRepo.path, '.takt', 'workflows', 'development-core.yaml');

      expect(result.exitCode).not.toBe(0);
      expect(output).toContain('Workflow bundle could not resolve call "builtin-caller/develop"');
      expect(output).toContain('call: development-core');
      expect(output).toContain(candidatePath);
      expect(output).toContain('excluded because enable_builtin_workflows is false');

      const runsDir = join(testRepo.path, '.takt', 'runs');
      expect(existsSync(runsDir)).toBe(true);
      const runSlugs = readdirSync(runsDir);
      expect(runSlugs).toHaveLength(1);
      const runDir = join(runsDir, runSlugs[0]!);
      const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf-8')) as {
        status?: string;
        reason?: string;
      };
      expect(meta.status).toBe('failed');
      expect(meta.reason).toContain('Workflow bundle could not resolve call "builtin-caller/develop"');
      expect(meta.reason).toContain('call: development-core');
      expect(meta.reason).toContain(candidatePath);
      expect(meta.reason).toContain('excluded because enable_builtin_workflows is false');

      const logsDir = join(runDir, 'logs');
      const jsonlFiles = readdirSync(logsDir).filter((file) => file.endsWith('.jsonl'));
      expect(jsonlFiles.length).toBeGreaterThan(0);
      const records = readFileSync(join(logsDir, jsonlFiles[0]!), 'utf-8')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { type?: string; reason?: string });
      expect(records.some((record) => record.type === 'workflow_start')).toBe(true);
      const abortRecord = records.find((record) => record.type === 'workflow_abort');
      expect(abortRecord).toBeDefined();
      expect(abortRecord?.reason).toContain('Workflow bundle could not resolve call "builtin-caller/develop"');
      expect(abortRecord?.reason).toContain('call: development-core');
      expect(abortRecord?.reason).toContain(candidatePath);
      expect(abortRecord?.reason).toContain('excluded because enable_builtin_workflows is false');
    }, 240_000);

    it('makes workflow doctor report the unresolved call instead of OK', () => {
      writeBuiltinCaller();

      const result = runTakt({
        args: ['workflow', 'doctor', 'builtin-caller'],
        cwd: testRepo.path,
        env: isolatedEnv.env,
        timeout: 240_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.exitCode).not.toBe(0);
      expect(output).not.toContain('Workflow OK');
      expect(output).toContain('call: development-core');
      expect(output).toContain('excluded because enable_builtin_workflows is false');
    }, 240_000);
  });
});
