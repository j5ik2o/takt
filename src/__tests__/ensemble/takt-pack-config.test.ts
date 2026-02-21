/**
 * Tests for takt-package.yaml parsing and validation.
 *
 * Covers:
 * - Full field parsing (description, path, takt.min_version)
 * - path field defaults, allowed/disallowed values
 * - takt.min_version format validation
 * - Version comparison (numeric, not lexicographic)
 * - Empty package detection (faceted/ and pieces/ presence)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseTaktPackConfig,
  validateTaktPackPath,
  validateMinVersion,
  isVersionCompatible,
  checkPackageHasContent,
  checkPackageHasContentWithContext,
  validateRealpathInsideRoot,
  resolvePackConfigPath,
} from '../../features/ensemble/takt-pack-config.js';

// ---------------------------------------------------------------------------
// parseTaktPackConfig
// ---------------------------------------------------------------------------

describe('parseTaktPackConfig', () => {
  it('should parse all fields when present', () => {
    // Given: a complete takt-package.yaml content
    const yaml = `
description: My package
path: takt
takt:
  min_version: "0.5.0"
`.trim();

    // When: parsed
    const config = parseTaktPackConfig(yaml);

    // Then: all fields are populated
    expect(config.description).toBe('My package');
    expect(config.path).toBe('takt');
    expect(config.takt?.min_version).toBe('0.5.0');
  });

  it('should default path to "." when omitted', () => {
    // Given: takt-package.yaml with no path field
    const yaml = `description: No path field`;

    // When: parsed
    const config = parseTaktPackConfig(yaml);

    // Then: path defaults to "."
    expect(config.path).toBe('.');
  });

  it('should parse minimal valid config (empty file is valid)', () => {
    // Given: empty yaml
    const yaml = '';

    // When: parsed
    const config = parseTaktPackConfig(yaml);

    // Then: defaults are applied
    expect(config.path).toBe('.');
    expect(config.description).toBeUndefined();
    expect(config.takt).toBeUndefined();
  });

  it('should parse config with only description', () => {
    // Given: config with description only
    const yaml = 'description: セキュリティレビュー用ファセット集';

    // When: parsed
    const config = parseTaktPackConfig(yaml);

    // Then: description is set, path defaults to "."
    expect(config.description).toBe('セキュリティレビュー用ファセット集');
    expect(config.path).toBe('.');
  });

  it('should parse path with subdirectory', () => {
    // Given: path with nested directory
    const yaml = 'path: pkg/takt';

    // When: parsed
    const config = parseTaktPackConfig(yaml);

    // Then: path is preserved as-is
    expect(config.path).toBe('pkg/takt');
  });
});

// ---------------------------------------------------------------------------
// validateTaktPackPath
// ---------------------------------------------------------------------------

describe('validateTaktPackPath', () => {
  it('should accept "." (current directory)', () => {
    // Given: default path
    // When: validated
    // Then: no error thrown
    expect(() => validateTaktPackPath('.')).not.toThrow();
  });

  it('should accept simple relative path "takt"', () => {
    expect(() => validateTaktPackPath('takt')).not.toThrow();
  });

  it('should accept nested relative path "pkg/takt"', () => {
    expect(() => validateTaktPackPath('pkg/takt')).not.toThrow();
  });

  it('should reject absolute path starting with "/"', () => {
    // Given: absolute path
    // When: validated
    // Then: throws an error
    expect(() => validateTaktPackPath('/etc/passwd')).toThrow();
  });

  it('should reject path starting with "~"', () => {
    // Given: home-relative path
    expect(() => validateTaktPackPath('~/takt')).toThrow();
  });

  it('should reject path containing ".." segment', () => {
    // Given: path with directory traversal
    expect(() => validateTaktPackPath('../outside')).toThrow();
  });

  it('should reject path with ".." in middle segment', () => {
    // Given: path with ".." embedded
    expect(() => validateTaktPackPath('takt/../etc')).toThrow();
  });

  it('should reject "../../etc" (multiple traversal)', () => {
    expect(() => validateTaktPackPath('../../etc')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateMinVersion
// ---------------------------------------------------------------------------

describe('validateMinVersion', () => {
  it('should accept valid SemVer "0.5.0"', () => {
    expect(() => validateMinVersion('0.5.0')).not.toThrow();
  });

  it('should accept "1.0.0"', () => {
    expect(() => validateMinVersion('1.0.0')).not.toThrow();
  });

  it('should accept "10.20.30"', () => {
    expect(() => validateMinVersion('10.20.30')).not.toThrow();
  });

  it('should reject pre-release suffix "1.0.0-alpha"', () => {
    // Given: version with pre-release suffix
    // When: validated
    // Then: throws an error (pre-release not supported)
    expect(() => validateMinVersion('1.0.0-alpha')).toThrow();
  });

  it('should reject "1.0.0-beta.1"', () => {
    expect(() => validateMinVersion('1.0.0-beta.1')).toThrow();
  });

  it('should reject "1.0" (missing patch segment)', () => {
    expect(() => validateMinVersion('1.0')).toThrow();
  });

  it('should reject "one.0.0" (non-numeric segment)', () => {
    expect(() => validateMinVersion('one.0.0')).toThrow();
  });

  it('should reject empty string', () => {
    expect(() => validateMinVersion('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isVersionCompatible (numeric comparison)
// ---------------------------------------------------------------------------

describe('isVersionCompatible', () => {
  it('should return true when minVersion equals currentVersion', () => {
    // Given: identical versions
    // When: compared
    // Then: compatible
    expect(isVersionCompatible('1.0.0', '1.0.0')).toBe(true);
  });

  it('should return true when currentVersion is greater', () => {
    expect(isVersionCompatible('0.5.0', '1.0.0')).toBe(true);
  });

  it('should return false when currentVersion is less than minVersion', () => {
    expect(isVersionCompatible('1.0.0', '0.9.0')).toBe(false);
  });

  it('should compare minor version numerically: 1.9.0 < 1.10.0', () => {
    // Given: versions that differ in minor only
    // When: comparing minVersion=1.10.0 against current=1.9.0
    // Then: 1.9 < 1.10 numerically → not compatible
    expect(isVersionCompatible('1.10.0', '1.9.0')).toBe(false);
  });

  it('should return true for minVersion=1.9.0 with current=1.10.0', () => {
    // Given: minVersion=1.9.0, current=1.10.0
    // Then: 1.10 > 1.9 numerically → compatible
    expect(isVersionCompatible('1.9.0', '1.10.0')).toBe(true);
  });

  it('should compare patch version numerically: 1.0.9 < 1.0.10', () => {
    expect(isVersionCompatible('1.0.10', '1.0.9')).toBe(false);
    expect(isVersionCompatible('1.0.9', '1.0.10')).toBe(true);
  });

  it('should return false when major is insufficient', () => {
    expect(isVersionCompatible('2.0.0', '1.99.99')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkPackageHasContent (empty package detection)
// ---------------------------------------------------------------------------

describe('checkPackageHasContent', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-pack-content-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should throw when neither faceted/ nor pieces/ exists', () => {
    // Given: empty package root directory
    // When: content check is performed
    // Then: throws an error (empty package not allowed)
    expect(() => checkPackageHasContent(tempDir)).toThrow();
  });

  it('should include manifest/path/hint details in contextual error', () => {
    const manifestPath = join(tempDir, '.takt', 'takt-package.yaml');
    expect(() => checkPackageHasContentWithContext(tempDir, {
      manifestPath,
      configuredPath: '.',
    })).toThrow(/path: \.takt/);
  });

  it('should not throw when only faceted/ exists', () => {
    // Given: package with faceted/ only
    mkdirSync(join(tempDir, 'faceted'), { recursive: true });

    // When: content check is performed
    // Then: no error (facet-only package is valid)
    expect(() => checkPackageHasContent(tempDir)).not.toThrow();
  });

  it('should not throw when only pieces/ exists', () => {
    // Given: package with pieces/ only
    mkdirSync(join(tempDir, 'pieces'), { recursive: true });

    // When: content check is performed
    // Then: no error (pieces-only package is valid)
    expect(() => checkPackageHasContent(tempDir)).not.toThrow();
  });

  it('should not throw when both faceted/ and pieces/ exist', () => {
    // Given: package with both directories
    mkdirSync(join(tempDir, 'faceted'), { recursive: true });
    mkdirSync(join(tempDir, 'pieces'), { recursive: true });

    // When: content check is performed
    // Then: no error
    expect(() => checkPackageHasContent(tempDir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateRealpathInsideRoot (symlink-safe path traversal check)
// ---------------------------------------------------------------------------

describe('validateRealpathInsideRoot', () => {
  let tmpRoot: string;
  let tmpOther: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-realpath-root-'));
    tmpOther = mkdtempSync(join(tmpdir(), 'takt-realpath-other-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpOther, { recursive: true, force: true });
  });

  it('should not throw when resolvedPath equals repoRoot', () => {
    // Given: path is exactly the root itself
    // When / Then: no error (root == root is valid)
    expect(() => validateRealpathInsideRoot(tmpRoot, tmpRoot)).not.toThrow();
  });

  it('should not throw when resolvedPath is a subdirectory inside root', () => {
    // Given: a subdirectory inside root
    const subdir = join(tmpRoot, 'subdir');
    mkdirSync(subdir);

    // When / Then: no error
    expect(() => validateRealpathInsideRoot(subdir, tmpRoot)).not.toThrow();
  });

  it('should throw when resolvedPath does not exist', () => {
    // Given: a path that does not exist on the filesystem
    const nonexistent = join(tmpRoot, 'nonexistent');

    // When / Then: throws because realpathSync fails
    expect(() => validateRealpathInsideRoot(nonexistent, tmpRoot)).toThrow();
  });

  it('should throw when resolvedPath is outside root', () => {
    // Given: a real directory that exists but is outside tmpRoot
    // When / Then: throws security error
    expect(() => validateRealpathInsideRoot(tmpOther, tmpRoot)).toThrow();
  });

  it('should throw when resolvedPath resolves outside root via symlink', () => {
    // Given: a symlink inside root that points to a directory outside root
    const symlinkPath = join(tmpRoot, 'escaped-link');
    symlinkSync(tmpOther, symlinkPath);

    // When / Then: realpath resolves the symlink → outside root → throws
    expect(() => validateRealpathInsideRoot(symlinkPath, tmpRoot)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolvePackConfigPath (takt-package.yaml search order)
// ---------------------------------------------------------------------------

describe('resolvePackConfigPath', () => {
  let extractDir: string;

  beforeEach(() => {
    extractDir = mkdtempSync(join(tmpdir(), 'takt-resolve-pack-'));
  });

  afterEach(() => {
    rmSync(extractDir, { recursive: true, force: true });
  });

  it('should return .takt/takt-package.yaml when only that path exists', () => {
    // Given: only .takt/takt-package.yaml exists
    const taktDir = join(extractDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(join(taktDir, 'takt-package.yaml'), 'description: dot-takt');

    // When: resolved
    const result = resolvePackConfigPath(extractDir);

    // Then: .takt/takt-package.yaml is returned
    expect(result).toBe(join(extractDir, '.takt', 'takt-package.yaml'));
  });

  it('should return root takt-package.yaml when only that path exists', () => {
    // Given: only root takt-package.yaml exists
    writeFileSync(join(extractDir, 'takt-package.yaml'), 'description: root');

    // When: resolved
    const result = resolvePackConfigPath(extractDir);

    // Then: root takt-package.yaml is returned
    expect(result).toBe(join(extractDir, 'takt-package.yaml'));
  });

  it('should prefer .takt/takt-package.yaml when both paths exist', () => {
    // Given: both .takt/takt-package.yaml and root takt-package.yaml exist
    const taktDir = join(extractDir, '.takt');
    mkdirSync(taktDir, { recursive: true });
    writeFileSync(join(taktDir, 'takt-package.yaml'), 'description: dot-takt');
    writeFileSync(join(extractDir, 'takt-package.yaml'), 'description: root');

    // When: resolved
    const result = resolvePackConfigPath(extractDir);

    // Then: .takt/takt-package.yaml takes precedence
    expect(result).toBe(join(extractDir, '.takt', 'takt-package.yaml'));
  });

  it('should throw when neither path exists', () => {
    // Given: empty extract directory
    // When / Then: throws an error
    expect(() => resolvePackConfigPath(extractDir)).toThrow('takt-package.yaml not found in');
  });
});
