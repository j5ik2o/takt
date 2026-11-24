import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalCreateInputSchema, type Goal } from '../infra/goals/schema.js';
import { goalInput, goalRecord } from './helpers/goal-fixtures.js';

const doubles = vi.hoisted(() => ({ createGoal: vi.fn(), resolveRepository: vi.fn(), readFile: vi.fn() }));
vi.mock('../infra/goals/service.js', () => ({ createGoal: doubles.createGoal }));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.resolveRepository }));

import { runGoalRegister } from '../features/goals/cli.js';

const repository = '/test/repository';
const goalId = goalRecord().id;
const readFile = doubles.readFile;

function stdin(text: string): Readable {
  return Readable.from([text]);
}

function run(input: string, stream: Readable) {
  return runGoalRegister('/test/project', { input }, stream, { readFile });
}

describe('runGoalRegister', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.createGoal.mockResolvedValue(goalRecord() as Goal);
    doubles.resolveRepository.mockResolvedValue(repository);
    doubles.readFile.mockResolvedValue(JSON.stringify({ id: goalId, ...goalInput() }));
  });

  it('reads the JSON file and saves the goal in the resolved repository by calling createGoal once', async () => {
    const result = await run('/tmp/goal.json', stdin(''));

    expect(doubles.resolveRepository).toHaveBeenCalledExactlyOnceWith('/test/project');
    expect(doubles.readFile).toHaveBeenCalledExactlyOnceWith('/tmp/goal.json');
    expect(doubles.createGoal).toHaveBeenCalledOnce();
    expect(doubles.createGoal.mock.calls[0]?.[0]).toMatchObject({ id: goalId, cwd: repository, objective: goalInput().objective });
    expect(result).toMatchObject({ id: goalId });
  });

  it('overrides any cwd from the input with the resolved repository directory', async () => {
    doubles.readFile.mockResolvedValue(JSON.stringify({ id: goalId, ...goalInput(), cwd: '/elsewhere' }));

    await run('/tmp/goal.json', stdin(''));

    expect(doubles.createGoal.mock.calls[0]?.[0]).toMatchObject({ cwd: repository });
  });

  it('reads the JSON from standard input when the input path is -', async () => {
    await run('-', stdin(JSON.stringify({ id: goalId, ...goalInput() })));

    expect(doubles.readFile).not.toHaveBeenCalled();
    expect(doubles.createGoal).toHaveBeenCalledOnce();
    expect(doubles.createGoal.mock.calls[0]?.[0]).toMatchObject({ id: goalId, cwd: repository });
  });

  it('keeps goal registration on the verification-owning createGoal path without a pre-aborted signal', async () => {
    await run('/tmp/goal.json', stdin(''));

    expect(doubles.createGoal.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('preserves multi-line specifications free text and accepts input that satisfies GoalCreateInputSchema', async () => {
    const specifications = { gherkin: 'Feature: 一覧\n  Scenario: 表示\n    Given 登録済み\n', quint: 'module goal {\n  val limit = 3\n}\n' };
    doubles.readFile.mockResolvedValue(JSON.stringify({ id: goalId, ...goalInput(), specifications }));

    await run('/tmp/goal.json', stdin(''));

    const passed = doubles.createGoal.mock.calls[0]?.[0];
    expect(GoalCreateInputSchema.safeParse(passed).success).toBe(true);
    expect(passed).toMatchObject({ specifications });
    expect(passed.specifications.gherkin).toBe(specifications.gherkin);
  });

  it('rejects input that violates GoalCreateInputSchema before calling createGoal', async () => {
    doubles.readFile.mockResolvedValue(JSON.stringify({ id: 'not-a-uuid', ...goalInput() }));

    await expect(run('/tmp/goal.json', stdin(''))).rejects.toThrow();
    expect(doubles.createGoal).not.toHaveBeenCalled();
  });

  it('rejects a non-array outOfScope before calling createGoal', async () => {
    doubles.readFile.mockResolvedValue(JSON.stringify({ id: goalId, ...goalInput(), outOfScope: 'GitHub連携' }));

    await expect(run('/tmp/goal.json', stdin(''))).rejects.toThrow();
    expect(doubles.createGoal).not.toHaveBeenCalled();
  });

  it('rejects a missing acceptanceCriteria before calling createGoal', async () => {
    const { acceptanceCriteria: _omitted, ...withoutAcceptanceCriteria } = goalInput();
    doubles.readFile.mockResolvedValue(JSON.stringify({ id: goalId, ...withoutAcceptanceCriteria }));

    await expect(run('/tmp/goal.json', stdin(''))).rejects.toThrow();
    expect(doubles.createGoal).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without calling createGoal', async () => {
    doubles.readFile.mockResolvedValue('{broken');

    await expect(run('/tmp/goal.json', stdin(''))).rejects.toThrow();
    expect(doubles.createGoal).not.toHaveBeenCalled();
  });

  it('propagates a duplicate goal failure from createGoal', async () => {
    doubles.createGoal.mockRejectedValue(new Error(`Goal already exists: ${goalId}`));

    await expect(run('/tmp/goal.json', stdin('')))
      .rejects.toThrow(`Goal already exists: ${goalId}`);
  });
});
