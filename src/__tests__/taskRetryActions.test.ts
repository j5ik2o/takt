/**
 * Tests for taskRetryActions — failed task retry functionality
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  selectOption: vi.fn(),
  promptInput: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  header: vi.fn(),
  blankLine: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/fs/session.js', () => ({
  extractFailureInfo: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  loadGlobalConfig: vi.fn(),
  loadPieceByIdentifier: vi.fn(),
}));

import { selectOption, promptInput } from '../shared/prompt/index.js';
import { success, error as logError } from '../shared/ui/index.js';
import { loadGlobalConfig, loadPieceByIdentifier } from '../infra/config/index.js';
import { retryFailedTask } from '../features/tasks/list/taskRetryActions.js';
import type { TaskListItem } from '../infra/task/types.js';
import type { PieceConfig } from '../core/models/index.js';

const mockSelectOption = vi.mocked(selectOption);
const mockPromptInput = vi.mocked(promptInput);
const mockSuccess = vi.mocked(success);
const mockLogError = vi.mocked(logError);
const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);
const mockLoadPieceByIdentifier = vi.mocked(loadPieceByIdentifier);

let tmpDir: string;

const defaultPieceConfig: PieceConfig = {
  name: 'default',
  description: 'Default piece',
  initialMovement: 'plan',
  maxIterations: 30,
  movements: [
    { name: 'plan', agent: 'planner', instruction: '' },
    { name: 'implement', agent: 'coder', instruction: '' },
    { name: 'review', agent: 'reviewer', instruction: '' },
  ],
};

const customPieceConfig: PieceConfig = {
  name: 'custom',
  description: 'Custom piece',
  initialMovement: 'step1',
  maxIterations: 10,
  movements: [
    { name: 'step1', agent: 'coder', instruction: '' },
    { name: 'step2', agent: 'reviewer', instruction: '' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-test-retry-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('retryFailedTask', () => {
  it('should requeue task with selected movement', async () => {
    // Given: a failed task directory with a task file
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_my-task');
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'my-task.yaml'), 'task: Do something\n');

    const task: TaskListItem = {
      kind: 'failed',
      name: 'my-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
    mockSelectOption.mockResolvedValue('implement');
    mockPromptInput.mockResolvedValue(''); // Empty retry note

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(true);
    expect(mockSuccess).toHaveBeenCalledWith('Task requeued: my-task');

    // Verify requeued file
    const requeuedFile = path.join(tasksDir, 'my-task.yaml');
    expect(fs.existsSync(requeuedFile)).toBe(true);
    const content = fs.readFileSync(requeuedFile, 'utf-8');
    expect(content).toContain('start_movement: implement');
  });

  it('should use piece field from task file instead of defaultPiece', async () => {
    // Given: a failed task with piece: custom in YAML
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_custom-task');
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(failedDir, 'custom-task.yaml'),
      'task: Do something\npiece: custom\n',
    );

    const task: TaskListItem = {
      kind: 'failed',
      name: 'custom-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    // Should be called with 'custom', not 'default'
    mockLoadPieceByIdentifier.mockImplementation((name: string) => {
      if (name === 'custom') return customPieceConfig;
      if (name === 'default') return defaultPieceConfig;
      return null;
    });
    mockSelectOption.mockResolvedValue('step2');
    mockPromptInput.mockResolvedValue('');

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(true);
    expect(mockLoadPieceByIdentifier).toHaveBeenCalledWith('custom', tmpDir);
    expect(mockSuccess).toHaveBeenCalledWith('Task requeued: custom-task');
  });

  it('should return false when user cancels movement selection', async () => {
    // Given
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_my-task');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'my-task.yaml'), 'task: Do something\n');

    const task: TaskListItem = {
      kind: 'failed',
      name: 'my-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
    mockSelectOption.mockResolvedValue(null); // User cancelled
    // No need to mock promptInput since user cancelled before reaching it

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(false);
    expect(mockSuccess).not.toHaveBeenCalled();
    expect(mockPromptInput).not.toHaveBeenCalled();
  });

  it('should return false and show error when piece not found', async () => {
    // Given
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_my-task');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'my-task.yaml'), 'task: Do something\n');

    const task: TaskListItem = {
      kind: 'failed',
      name: 'my-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'nonexistent' });
    mockLoadPieceByIdentifier.mockReturnValue(null);

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(false);
    expect(mockLogError).toHaveBeenCalledWith(
      'Piece "nonexistent" not found. Cannot determine available movements.',
    );
  });

  it('should fallback to defaultPiece when task file has no piece field', async () => {
    // Given: a failed task without piece field in YAML
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_plain-task');
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(failedDir, 'plain-task.yaml'),
      'task: Do something without piece\n',
    );

    const task: TaskListItem = {
      kind: 'failed',
      name: 'plain-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something without piece',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockImplementation((name: string) => {
      if (name === 'default') return defaultPieceConfig;
      return null;
    });
    mockSelectOption.mockResolvedValue('plan');
    mockPromptInput.mockResolvedValue('');

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(true);
    expect(mockLoadPieceByIdentifier).toHaveBeenCalledWith('default', tmpDir);
  });

  it('should not add start_movement when initial movement is selected', async () => {
    // Given
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_my-task');
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'my-task.yaml'), 'task: Do something\n');

    const task: TaskListItem = {
      kind: 'failed',
      name: 'my-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
    mockSelectOption.mockResolvedValue('plan'); // Initial movement
    mockPromptInput.mockResolvedValue(''); // Empty retry note

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(true);

    // Verify requeued file does not have start_movement
    const requeuedFile = path.join(tasksDir, 'my-task.yaml');
    const content = fs.readFileSync(requeuedFile, 'utf-8');
    expect(content).not.toContain('start_movement');
  });

  it('should add retry_note when user provides one', async () => {
    // Given
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_retry-note-task');
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'retry-note-task.yaml'), 'task: Do something\n');

    const task: TaskListItem = {
      kind: 'failed',
      name: 'retry-note-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
    mockSelectOption.mockResolvedValue('implement');
    mockPromptInput.mockResolvedValue('Fixed spawn node ENOENT error');

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(true);

    const requeuedFile = path.join(tasksDir, 'retry-note-task.yaml');
    const content = fs.readFileSync(requeuedFile, 'utf-8');
    expect(content).toContain('start_movement: implement');
    expect(content).toContain('retry_note: "Fixed spawn node ENOENT error"');
  });

  it('should not add retry_note when user skips it', async () => {
    // Given
    const failedDir = path.join(tmpDir, '.takt', 'failed', '2025-01-15T12-34-56_no-note-task');
    const tasksDir = path.join(tmpDir, '.takt', 'tasks');
    fs.mkdirSync(failedDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(failedDir, 'no-note-task.yaml'), 'task: Do something\n');

    const task: TaskListItem = {
      kind: 'failed',
      name: 'no-note-task',
      createdAt: '2025-01-15T12:34:56',
      filePath: failedDir,
      content: 'Do something',
    };

    mockLoadGlobalConfig.mockReturnValue({ defaultPiece: 'default' });
    mockLoadPieceByIdentifier.mockReturnValue(defaultPieceConfig);
    mockSelectOption.mockResolvedValue('implement');
    mockPromptInput.mockResolvedValue(''); // Empty string - user skipped

    // When
    const result = await retryFailedTask(task, tmpDir);

    // Then
    expect(result).toBe(true);

    const requeuedFile = path.join(tasksDir, 'no-note-task.yaml');
    const content = fs.readFileSync(requeuedFile, 'utf-8');
    expect(content).toContain('start_movement: implement');
    expect(content).not.toContain('retry_note');
  });
});
