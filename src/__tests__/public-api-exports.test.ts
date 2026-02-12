import { describe, expect, it } from 'vitest';

describe('public API exports', () => {
  it('should expose piece usecases, engine, and piece loader APIs', async () => {
    // Given: パッケージの公開API
    const api = await import('../index.js');

    // When: 主要なユースケース関数とエンジン公開API・piece読み込みAPIを参照する
    // Then: 必要な公開シンボルが利用できる
    expect(typeof api.executeAgent).toBe('function');
    expect(typeof api.generateReport).toBe('function');
    expect(typeof api.executePart).toBe('function');
    expect(typeof api.judgeStatus).toBe('function');
    expect(typeof api.evaluateCondition).toBe('function');
    expect(typeof api.decomposeTask).toBe('function');

    expect(typeof api.PieceEngine).toBe('function');

    expect(typeof api.loadPiece).toBe('function');
    expect(typeof api.loadPieceByIdentifier).toBe('function');
    expect(typeof api.listPieces).toBe('function');
  });

  it('should not expose internal engine implementation details', async () => {
    // Given: パッケージの公開API
    const api = await import('../index.js');

    // When: 非公開にすべき内部シンボルの有無を確認する
    // Then: 内部実装詳細は公開されていない
    expect('AgentRunner' in api).toBe(false);
    expect('RuleEvaluator' in api).toBe(false);
    expect('AggregateEvaluator' in api).toBe(false);
    expect('evaluateAggregateConditions' in api).toBe(false);
    expect('needsStatusJudgmentPhase' in api).toBe(false);
    expect('StatusJudgmentBuilder' in api).toBe(false);
    expect('buildEditRule' in api).toBe(false);
    expect('detectRuleIndex' in api).toBe(false);
    expect('ParallelLogger' in api).toBe(false);
    expect('InstructionBuilder' in api).toBe(false);
    expect('ReportInstructionBuilder' in api).toBe(false);
    expect('COMPLETE_MOVEMENT' in api).toBe(false);
    expect('ABORT_MOVEMENT' in api).toBe(false);
    expect('ERROR_MESSAGES' in api).toBe(false);
    expect('determineNextMovementByRules' in api).toBe(false);
    expect('extractBlockedPrompt' in api).toBe(false);
    expect('LoopDetector' in api).toBe(false);
    expect('createInitialState' in api).toBe(false);
    expect('addUserInput' in api).toBe(false);
    expect('getPreviousOutput' in api).toBe(false);
    expect('handleBlocked' in api).toBe(false);
  });

  it('should not expose infrastructure implementations and internal shared utilities', async () => {
    // Given: パッケージの公開API
    const api = await import('../index.js');

    // When: 非公開にすべきインフラ実装と内部ユーティリティの有無を確認する
    // Then: 直接利用させない実装詳細は公開されていない
    expect('ClaudeClient' in api).toBe(false);
    expect('executeClaudeCli' in api).toBe(false);
    expect('CodexClient' in api).toBe(false);
    expect('mapToCodexSandboxMode' in api).toBe(false);
    expect('getResourcesDir' in api).toBe(false);
    expect('DEFAULT_PIECE_NAME' in api).toBe(false);
    expect('buildPrompt' in api).toBe(false);
    expect('writeFileAtomic' in api).toBe(false);
    expect('getInputHistoryPath' in api).toBe(false);
    expect('MAX_INPUT_HISTORY' in api).toBe(false);
    expect('loadInputHistory' in api).toBe(false);
    expect('saveInputHistory' in api).toBe(false);
    expect('addToInputHistory' in api).toBe(false);
    expect('getPersonaSessionsPath' in api).toBe(false);
    expect('loadPersonaSessions' in api).toBe(false);
    expect('savePersonaSessions' in api).toBe(false);
    expect('updatePersonaSession' in api).toBe(false);
    expect('clearPersonaSessions' in api).toBe(false);
    expect('getWorktreeSessionsDir' in api).toBe(false);
    expect('encodeWorktreePath' in api).toBe(false);
    expect('getWorktreeSessionPath' in api).toBe(false);
    expect('loadWorktreeSessions' in api).toBe(false);
    expect('updateWorktreeSession' in api).toBe(false);
  });
});
