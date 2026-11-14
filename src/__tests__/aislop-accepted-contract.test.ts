import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AISLOP_ENV,
  TOOL_SPECIFIERS,
  assertReportShape,
  checkReport,
  compareFindings,
} from '../../scripts/check-aislop.mjs';

type Finding = {
  engine: string;
  rule: string;
  file: string;
  message: string;
};

type Diagnostic = {
  engine: string;
  rule: string;
  filePath: string;
  message: string;
  severity: string;
  line: number;
};

type AcceptedGroup = {
  reason: string;
  findings: Finding[];
};

type AcceptedList = {
  engines: string[];
  missingToolsAllowed: Record<string, string>;
  accepted: AcceptedGroup[];
};

type ScanReport = {
  schemaVersion: string;
  cliVersion: string;
  engines: Record<string, { skipped: boolean; failed?: boolean; missingTools?: string[] }>;
  diagnostics: Diagnostic[];
};

const acceptedUrl = new URL('../../scripts/aislop-accepted.json', import.meta.url);
const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));

const finding: Finding = {
  engine: 'code-quality',
  rule: 'complexity/file-too-large',
  file: 'src/core/example.ts',
  message: 'File too large',
};

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    engine: finding.engine,
    rule: finding.rule,
    filePath: finding.file,
    message: finding.message,
    severity: 'warning',
    line: 0,
    ...overrides,
  };
}

function listOf(groups: AcceptedGroup[]): AcceptedList {
  return {
    engines: [...new Set(groups.flatMap((group) => group.findings.map((item) => item.engine)))],
    missingToolsAllowed: {},
    accepted: groups,
  };
}

describe('scripts/check-aislop.mjs comparison contract', () => {
  it('ignores line changes when engine, rule, file and message match the accepted list', () => {
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [finding] }];

    expect(compareFindings(accepted, [diagnostic({ line: 12 })])).toEqual({
      unlisted: [],
      resolved: [],
      countMismatches: [],
    });
  });

  it('reports a warn-or-error diagnostic that the accepted list does not contain', () => {
    const result = compareFindings([], [
      diagnostic({ rule: 'security/new-function', severity: 'error', line: 3 }),
    ]);

    expect(result.unlisted).toEqual([
      { ...finding, rule: 'security/new-function', line: 3 },
    ]);
  });

  it('does not gate info-level diagnostics that are absent from the list', () => {
    expect(compareFindings([], [diagnostic({ severity: 'info' })]).unlisted).toEqual([]);
  });

  it('treats the same rule and file under a different engine as a distinct finding', () => {
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [finding] }];

    expect(compareFindings(accepted, [diagnostic({ engine: 'lint' })])).toEqual({
      unlisted: [{ ...finding, engine: 'lint', line: 0 }],
      resolved: [finding],
      countMismatches: [],
    });
  });

  it('reports a listed finding that the scan no longer produces as resolved', () => {
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [finding] }];

    expect(compareFindings(accepted, []).resolved).toEqual([finding]);
  });

  it('does not report resolved or unlisted when one of several same-key findings is fixed on the source side', () => {
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [finding, finding, finding, finding] }];
    const scanned = [
      diagnostic({ line: 1 }),
      diagnostic({ line: 2 }),
      diagnostic({ line: 3 }),
    ];

    const result = compareFindings(accepted, scanned);

    expect(result.unlisted).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.countMismatches).toEqual([
      { ...finding, line: 1, acceptedCount: 4, scannedCount: 3 },
    ]);
  });

  it('does not report resolved or unlisted when one more same-key finding appears on the source side', () => {
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [finding, finding, finding, finding] }];
    const scanned = [
      diagnostic({ line: 1 }),
      diagnostic({ line: 2 }),
      diagnostic({ line: 3 }),
      diagnostic({ line: 4 }),
      diagnostic({ line: 5 }),
    ];

    const result = compareFindings(accepted, scanned);

    expect(result.unlisted).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.countMismatches).toEqual([
      { ...finding, line: 1, acceptedCount: 4, scannedCount: 5 },
    ]);
  });

  it('does not report resolved or unlisted when only the "on line N" number inside the message changes', () => {
    const duplicateImport = (line: number) => ({
      engine: 'ai-slop',
      rule: 'ai-slop/duplicate-import',
      file: 'eval/repair-strategy-cases.mjs',
      message: `"node:fs" is also imported on line ${line}. Merge into a single import statement.`,
    });
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [duplicateImport(1)] }];
    const scanned = [
      { ...duplicateImport(83), filePath: 'eval/repair-strategy-cases.mjs', severity: 'warning', line: 5 },
    ];

    const result = compareFindings(accepted, scanned);

    expect(result.unlisted).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(result.countMismatches).toEqual([]);
  });

  it('still treats a different import specifier in the message as a distinct finding', () => {
    const withSpec = (spec: string) => ({
      engine: 'ai-slop',
      rule: 'ai-slop/duplicate-import',
      file: 'eval/repair-strategy-cases.mjs',
      message: `"${spec}" is also imported on line 1. Merge into a single import statement.`,
    });
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [withSpec('node:fs')] }];
    const scanned = [
      { ...withSpec('node:path'), filePath: 'eval/repair-strategy-cases.mjs', severity: 'warning', line: 1 },
    ];

    const result = compareFindings(accepted, scanned);

    expect(result.unlisted).toHaveLength(1);
    expect(result.resolved).toEqual([withSpec('node:fs')]);
    expect(result.countMismatches).toEqual([]);
  });

  it('still treats a changed line-limit value in the message as a distinct finding', () => {
    const tooLarge = (limit: number) => ({
      engine: 'code-quality',
      rule: 'complexity/file-too-large',
      file: 'src/core/example.ts',
      message: `File exceeds the ${limit} line limit`,
    });
    const accepted: AcceptedGroup[] = [{ reason: '理由', findings: [tooLarge(400)] }];
    const scanned = [
      { ...tooLarge(441), filePath: 'src/core/example.ts', severity: 'warning', line: 1 },
    ];

    const result = compareFindings(accepted, scanned);

    expect(result.unlisted).toHaveLength(1);
    expect(result.resolved).toEqual([tooLarge(400)]);
    expect(result.countMismatches).toEqual([]);
  });
});

describe('scripts/check-aislop.mjs failure contract', () => {
  it('fails when a listed finding disappears from the scan', () => {
    const list = listOf([{ reason: '理由', findings: [finding] }]);

    const failures = checkReport(list, {
      schemaVersion: '1',
      cliVersion: '0.20.1',
      engines: { 'code-quality': { skipped: false } },
      diagnostics: [],
    });

    expect(failures.join('\n')).toContain('code-quality');
    expect(failures.join('\n')).toContain('すべて出なくなりました');
  });

  it('fails when a listed engine no longer runs', () => {
    const list: AcceptedList = {
      engines: ['code-quality'],
      missingToolsAllowed: {},
      accepted: [],
    };

    const failures = checkReport(list, {
      schemaVersion: '1',
      cliVersion: '0.20.1',
      engines: {},
      diagnostics: [],
    });

    expect(failures.join('\n')).toContain('code-quality');
  });

  it('fails when a listed engine reports failed even without skipped', () => {
    const list: AcceptedList = {
      engines: ['security'],
      missingToolsAllowed: {},
      accepted: [],
    };

    const failures = checkReport(list, {
      schemaVersion: '1',
      cliVersion: '0.20.1',
      engines: { security: { skipped: false, failed: true } },
      diagnostics: [],
    });

    expect(failures.join('\n')).toContain('security');
    expect(failures.join('\n')).toContain('failed');
  });

  it('does not fail when an engine that is not listed in engines is silently stopped (format is the explicit exception)', () => {
    const list: AcceptedList = {
      engines: ['security'],
      missingToolsAllowed: { ruff: 'Python は無い' },
      accepted: [{ reason: '理由', findings: [{ engine: 'security', rule: 'security/x', file: 'a.ts', message: 'm' }] }],
    };

    const failures = checkReport(list, {
      schemaVersion: '1',
      cliVersion: '0.20.1',
      engines: {
        format: { issues: 0, skipped: false, missingTools: ['ruff'] },
        security: { issues: 1, skipped: false },
      },
      diagnostics: [{ engine: 'security', rule: 'security/x', filePath: 'a.ts', message: 'm', severity: 'warning', line: 1 }],
    });

    expect(failures).toEqual([]);
  });

  it('fails when a listed engine with accepted findings returns none (all gone)', () => {
    const list: AcceptedList = {
      engines: ['security'],
      missingToolsAllowed: {},
      accepted: [{ reason: '理由', findings: [{ engine: 'security', rule: 'security/x', file: 'a.ts', message: 'm' }] }],
    };

    const failures = checkReport(list, {
      schemaVersion: '1',
      cliVersion: '0.20.1',
      engines: { security: { issues: 0, skipped: false } },
      diagnostics: [],
    });

    expect(failures.join('\n')).toContain('security');
    expect(failures.join('\n')).toContain('すべて出なくなりました');
  });

  it('fails when an unlisted warn-or-error diagnostic appears', () => {
    const list = listOf([{ reason: '理由', findings: [finding] }]);

    const failures = checkReport(list, {
      schemaVersion: '1',
      cliVersion: '0.20.1',
      engines: { 'code-quality': { skipped: false } },
      diagnostics: [diagnostic(), diagnostic({ rule: 'security/eval', line: 4 })],
    });

    expect(failures.join('\n')).toContain('security/eval');
  });

  it('fails on a count mismatch for a shared key instead of reporting resolved or unlisted', () => {
    const repeated: Finding = {
      engine: 'code-quality',
      rule: 'code-quality/duplicate-block',
      file: 'src/core/workflow/engine/StepExecutor.ts',
      message: 'Duplicate block detected',
    };
    const list = listOf([{ reason: '理由', findings: [repeated, repeated, repeated, repeated] }]);
    const scanned = [
      { ...repeated, filePath: repeated.file, severity: 'warning', line: 1 },
      { ...repeated, filePath: repeated.file, severity: 'warning', line: 2 },
      { ...repeated, filePath: repeated.file, severity: 'warning', line: 3 },
    ];

    const failures = checkReport(list, {
      schemaVersion: '1',
      cliVersion: '0.20.1',
      engines: { 'code-quality': { skipped: false } },
      diagnostics: scanned,
    });

    expect(failures.join('\n')).toContain('件数が一致しない');
    expect(failures.join('\n')).not.toContain('出なくなった指摘');
  });

  it('passes when the scan matches the accepted list exactly', () => {
    const list = listOf([{ reason: '理由', findings: [finding] }]);

    expect(
      checkReport(list, {
        schemaVersion: '1',
        cliVersion: '0.20.1',
        engines: { 'code-quality': { skipped: false } },
        diagnostics: [diagnostic()],
      }),
    ).toEqual([]);
  });

  it('rejects a scan report whose schemaVersion is not the supported one', () => {
    expect(() => assertReportShape({ schemaVersion: 1, cliVersion: '0.99.0' })).toThrow(
      /schemaVersion が 1/,
    );
  });
});

describe('scripts/check-aislop.mjs environment isolation', () => {
  it('stops telemetry and the update notifier before spawning aislop', () => {
    expect(AISLOP_ENV).toEqual({
      AISLOP_NO_TELEMETRY: '1',
      AISLOP_NO_UPDATE_NOTIFIER: '1',
    });
  });

  it('keeps the tool specifiers that aislop resolves from its own package', () => {
    expect(TOOL_SPECIFIERS).toEqual({
      oxlint: 'oxlint',
      '@biomejs/biome': '@biomejs/biome/package.json',
      knip: 'knip',
    });
  });
});

describe('scripts/aislop-accepted.json', () => {
  const list = JSON.parse(readFileSync(acceptedUrl, 'utf8')) as AcceptedList;

  it('names at least one engine to observe', () => {
    expect(Array.isArray(list.engines)).toBe(true);
    expect(list.engines.length).toBeGreaterThan(0);
  });

  it('does not list format, whose silent stop cannot be told apart from an empty run', () => {
    expect(list.engines).not.toContain('format');
  });

  it('gives every accepted group a reason and at least one finding', () => {
    for (const group of list.accepted) {
      expect(group.reason).toEqual(expect.stringMatching(/\S/));
      expect(group.findings.length).toBeGreaterThan(0);
    }
  });

  it('keys every finding by engine, rule, file and message without line numbers', () => {
    for (const group of list.accepted) {
      for (const item of group.findings) {
        expect(Object.keys(item).sort()).toEqual(['engine', 'file', 'message', 'rule']);
      }
    }
  });

  it('gives every tolerated missing tool a non-empty reason', () => {
    for (const reason of Object.values(list.missingToolsAllowed)) {
      expect(reason).toEqual(expect.stringMatching(/\S/));
    }
  });
});

describe('npm wiring for check:aislop', () => {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('exposes check:aislop as node scripts/check-aislop.mjs', () => {
    expect(manifest.scripts?.['check:aislop']).toBe('node scripts/check-aislop.mjs');
  });

  it('pins aislop to an exact version in devDependencies', () => {
    expect(manifest.devDependencies?.aislop).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('takt-check.sh quality gate', () => {
  it('runs npm run check:aislop after the existing gates without reordering them', () => {
    const gatePath = fileURLToPath(
      new URL('../../.takt/quality-gates/takt-check.sh', import.meta.url),
    );
    const lines = readFileSync(gatePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('set '));

    expect(lines.slice(0, 5)).toEqual([
      'npm run build',
      'npm run lint',
      'npm test',
      'npm run test:it',
      'npm run test:e2e:mock',
    ]);
    expect(lines.at(-1)).toBe('npm run check:aislop');
  });
});

describe('workflow_overrides quality gates', () => {
  const configPath = fileURLToPath(new URL('../../.takt/config.yaml', import.meta.url));
  const gateText = 'Run `npm run check:aislop` and verify it passes';
  const yaml = readFileSync(configPath, 'utf8');

  it('appends the aislop gate to implement, reimplement and fix', () => {
    for (const step of ['implement', 'reimplement', 'fix']) {
      const gates = extractStepQualityGates(yaml, step);
      expect(gates.some((entry) => entry.includes(gateText))).toBe(true);
    }
  });

  it('does not add the aislop gate to ai-antipattern-fix', () => {
    const gates = extractStepQualityGates(yaml, 'ai-antipattern-fix');
    expect(gates.some((entry) => entry.includes(gateText))).toBe(false);
  });
});

function extractStepQualityGates(source: string, step: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === `${step}:`);
  if (start < 0) {
    return [];
  }
  const entries: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (trimmed.length === 0) {
      continue;
    }
    if (!trimmed.startsWith('-') && indent <= 4) {
      break;
    }
    if (trimmed.startsWith('- ')) {
      entries.push(trimmed.slice(2).replace(/^"|"$/g, ''));
    }
  }
  return entries;
}
