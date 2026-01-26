/**
 * Tests for takt config functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  getBuiltinWorkflow,
  loadAllWorkflows,
} from '../config/loader.js';
import {
  getCurrentWorkflow,
  setCurrentWorkflow,
  getProjectConfigDir,
  loadInputHistory,
  saveInputHistory,
  addToInputHistory,
  getInputHistoryPath,
  MAX_INPUT_HISTORY,
} from '../config/paths.js';
import { loadProjectConfig } from '../config/projectConfig.js';

describe('getBuiltinWorkflow', () => {
  it('should return null for all workflow names (no built-in workflows)', () => {
    expect(getBuiltinWorkflow('default')).toBeNull();
    expect(getBuiltinWorkflow('passthrough')).toBeNull();
    expect(getBuiltinWorkflow('unknown')).toBeNull();
    expect(getBuiltinWorkflow('')).toBeNull();
  });
});

describe('loadAllWorkflows', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should only load workflows from global ~/.takt/workflows/ (not project-local)', () => {
    // Project-local workflows should NOT be loaded anymore
    const workflowsDir = join(testDir, '.takt', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    const sampleWorkflow = `
name: test-workflow
description: Test workflow
max_iterations: 10
steps:
  - name: step1
    agent: coder
    instruction: "{task}"
    transitions:
      - condition: done
        next_step: COMPLETE
`;
    writeFileSync(join(workflowsDir, 'test.yaml'), sampleWorkflow);

    const workflows = loadAllWorkflows();

    // Project-local workflow should NOT be loaded
    expect(workflows.has('test')).toBe(false);
  });
});

describe('getCurrentWorkflow', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return default when no config exists', () => {
    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('default');
  });

  it('should return saved workflow name from config.yaml', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'workflow: default\n');

    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('default');
  });

  it('should return default for empty config', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), '');

    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('default');
  });
});

describe('setCurrentWorkflow', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should save workflow name to config.yaml', () => {
    setCurrentWorkflow(testDir, 'my-workflow');

    const config = loadProjectConfig(testDir);

    expect(config.workflow).toBe('my-workflow');
  });

  it('should create config directory if not exists', () => {
    const configDir = getProjectConfigDir(testDir);
    expect(existsSync(configDir)).toBe(false);

    setCurrentWorkflow(testDir, 'test');

    expect(existsSync(configDir)).toBe(true);
  });

  it('should overwrite existing workflow name', () => {
    setCurrentWorkflow(testDir, 'first');
    setCurrentWorkflow(testDir, 'second');

    const workflow = getCurrentWorkflow(testDir);

    expect(workflow).toBe('second');
  });
});

describe('loadInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty array when no history exists', () => {
    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });

  it('should load saved history entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const entries = ['"first entry"', '"second entry"'];
    writeFileSync(getInputHistoryPath(testDir), entries.join('\n'));

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first entry', 'second entry']);
  });

  it('should handle multi-line entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const multiLine = 'line1\nline2\nline3';
    writeFileSync(getInputHistoryPath(testDir), JSON.stringify(multiLine));

    const history = loadInputHistory(testDir);

    expect(history).toHaveLength(1);
    expect(history[0]).toBe('line1\nline2\nline3');
  });
});

describe('saveInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should save history entries', () => {
    saveInputHistory(testDir, ['entry1', 'entry2']);

    const content = readFileSync(getInputHistoryPath(testDir), 'utf-8');
    expect(content).toBe('"entry1"\n"entry2"');
  });

  it('should create config directory if not exists', () => {
    const configDir = getProjectConfigDir(testDir);
    expect(existsSync(configDir)).toBe(false);

    saveInputHistory(testDir, ['test']);

    expect(existsSync(configDir)).toBe(true);
  });

  it('should preserve multi-line entries', () => {
    const multiLine = 'line1\nline2';
    saveInputHistory(testDir, [multiLine]);

    const history = loadInputHistory(testDir);

    expect(history[0]).toBe('line1\nline2');
  });
});

describe('addToInputHistory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should add new entry to history', () => {
    addToInputHistory(testDir, 'first');
    addToInputHistory(testDir, 'second');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first', 'second']);
  });

  it('should not add consecutive duplicates', () => {
    addToInputHistory(testDir, 'same');
    addToInputHistory(testDir, 'same');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['same']);
  });

  it('should allow non-consecutive duplicates', () => {
    addToInputHistory(testDir, 'first');
    addToInputHistory(testDir, 'second');
    addToInputHistory(testDir, 'first');

    const history = loadInputHistory(testDir);

    expect(history).toEqual(['first', 'second', 'first']);
  });
});

describe('saveInputHistory - edge cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should trim history to MAX_INPUT_HISTORY entries', () => {
    const entries = Array.from({ length: 150 }, (_, i) => `entry${i}`);
    saveInputHistory(testDir, entries);

    const history = loadInputHistory(testDir);

    expect(history).toHaveLength(MAX_INPUT_HISTORY);
    // First 50 entries should be trimmed, keeping entries 50-149
    expect(history[0]).toBe('entry50');
    expect(history[MAX_INPUT_HISTORY - 1]).toBe('entry149');
  });

  it('should handle empty history array', () => {
    saveInputHistory(testDir, []);

    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });
});

describe('loadInputHistory - edge cases', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should skip invalid JSON entries', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    // Mix of valid JSON and invalid entries
    const content = '"valid entry"\ninvalid json\n"another valid"';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    // Invalid entries should be skipped
    expect(history).toEqual(['valid entry', 'another valid']);
  });

  it('should handle completely corrupted file', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    // All invalid JSON
    const content = 'not json\nalso not json\nstill not json';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    // All entries should be skipped
    expect(history).toEqual([]);
  });

  it('should handle file with only whitespace lines', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const content = '   \n\n  \n';
    writeFileSync(getInputHistoryPath(testDir), content);

    const history = loadInputHistory(testDir);

    expect(history).toEqual([]);
  });
});

describe('saveProjectConfig - gitignore copy', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `takt-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should copy .gitignore when creating new config', () => {
    setCurrentWorkflow(testDir, 'test');

    const configDir = getProjectConfigDir(testDir);
    const gitignorePath = join(configDir, '.gitignore');

    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should copy .gitignore to existing config directory without one', () => {
    // Create config directory without .gitignore
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'workflow: existing\n');

    // Save config should still copy .gitignore
    setCurrentWorkflow(testDir, 'updated');

    const gitignorePath = join(configDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
  });

  it('should not overwrite existing .gitignore', () => {
    const configDir = getProjectConfigDir(testDir);
    mkdirSync(configDir, { recursive: true });
    const customContent = '# Custom gitignore\nmy-custom-file';
    writeFileSync(join(configDir, '.gitignore'), customContent);

    setCurrentWorkflow(testDir, 'test');

    const gitignorePath = join(configDir, '.gitignore');
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toBe(customContent);
  });
});
