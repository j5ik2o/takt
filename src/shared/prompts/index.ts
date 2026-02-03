/**
 * Markdown template loader
 *
 * Loads prompt strings from Markdown template files (.md),
 * applies {{variable}} substitution and {{#if}}...{{else}}...{{/if}}
 * conditional blocks.
 *
 * Templates are organized in language subdirectories:
 *   {lang}/{name}.md  — localized templates
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from '../../core/models/types.js';

/** Cached raw template text (before variable substitution) */
const templateCache = new Map<string, string>();

/**
 * Resolve template file path.
 *
 * Loads `{lang}/{name}.md`.
 * Throws if the file does not exist.
 */
function resolveTemplatePath(name: string, lang: Language): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const localizedPath = join(__dirname, lang, `${name}.md`);
  if (existsSync(localizedPath)) {
    return localizedPath;
  }

  throw new Error(
    `Template not found: ${name} (lang: ${lang})`,
  );
}

/**
 * Strip HTML meta comments (<!-- ... -->) from template content.
 */
function stripMetaComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Read raw template text with caching.
 */
function readTemplate(filePath: string): string {
  const cached = templateCache.get(filePath);
  if (cached !== undefined) return cached;

  const raw = readFileSync(filePath, 'utf-8');
  const content = stripMetaComments(raw);
  templateCache.set(filePath, content);
  return content;
}

/**
 * Process {{#if variable}}...{{else}}...{{/if}} conditional blocks.
 *
 * A variable is truthy when:
 * - It is a non-empty string
 * - It is boolean true
 *
 * Nesting is NOT supported (per architecture decision).
 */
function processConditionals(
  template: string,
  vars: Record<string, string | boolean>,
): string {
  // Pattern: {{#if varName}}...content...{{else}}...altContent...{{/if}}
  // or:      {{#if varName}}...content...{{/if}}
  return template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, varName: string, body: string): string => {
      const value = vars[varName];
      const isTruthy = value !== undefined && value !== false && value !== '';

      const elseIndex = body.indexOf('{{else}}');
      if (isTruthy) {
        return elseIndex >= 0 ? body.slice(0, elseIndex) : body;
      }
      return elseIndex >= 0 ? body.slice(elseIndex + '{{else}}'.length) : '';
    },
  );
}

/**
 * Replace {{variableName}} placeholders with values from vars.
 * Undefined variables are replaced with empty string.
 */
function substituteVariables(
  template: string,
  vars: Record<string, string | boolean>,
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, varName: string) => {
      const value = vars[varName];
      if (value === undefined || value === false) return '';
      if (value === true) return 'true';
      return value;
    },
  );
}

/**
 * Render a template string by processing conditionals then substituting variables.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | boolean>,
): string {
  const afterConditionals = processConditionals(template, vars);
  return substituteVariables(afterConditionals, vars);
}

/**
 * Load a Markdown template, apply variable substitution and conditional blocks.
 *
 * @param name  Template name (without extension), e.g. 'score_interactive_system_prompt'
 * @param lang  Language ('en' | 'ja').
 * @param vars  Variable values to substitute
 * @returns Final prompt string
 */
export function loadTemplate(
  name: string,
  lang: Language,
  vars?: Record<string, string | boolean>,
): string {
  const filePath = resolveTemplatePath(name, lang);
  const raw = readTemplate(filePath);

  if (vars) {
    return renderTemplate(raw, vars);
  }
  return raw;
}

/** Reset cache (for tests) */
export function _resetCache(): void {
  templateCache.clear();
}
