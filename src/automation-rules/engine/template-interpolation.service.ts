import { Injectable, Logger } from '@nestjs/common';

/**
 * Regex for template tokens: `{{fieldName}}` or `{{Module.Field.Path}}`.
 * Only alphanumerics, underscores and dots — no expression syntax, so there is
 * nothing to inject.
 */
const TOKEN_REGEX = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

/** Path segments that would reach through to the prototype chain. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * TemplateInterpolationService — resolves `{{field}}` tokens against record data.
 *
 * No built-in fallback text. A greeting is content, and content belongs to
 * whoever writes the template: a hard-coded default picks a language on behalf of
 * a product sold in Vietnamese, English and Arabic. An unresolved token renders
 * as empty text, and the dry run reports which tokens a given record cannot
 * resolve, so the author finds out before sending. Callers wanting a default pass
 * one explicitly.
 *
 * Security: field lookup only — no code execution, no expressions.
 */
@Injectable()
export class TemplateInterpolationService {
  private readonly logger = new Logger(TemplateInterpolationService.name);

  /**
   * Interpolate a template string with record data.
   *
   * @param template - String containing `{{token}}` placeholders
   * @param data - Record data to resolve tokens against
   * @param options.fallbackMap - Explicit replacement for specific token paths
   * @param options.defaultFallback - Replacement for any other unresolved token
   *
   * @example
   * interpolate('Hello {{firstName}}!', { firstName: 'John' }) // 'Hello John!'
   * interpolate('Hello {{firstName}}!', {})                    // 'Hello !'
   */
  interpolate(
    template: string,
    data: Record<string, any>,
    options?: {
      fallbackMap?: Record<string, string>;
      defaultFallback?: string;
    },
  ): string {
    if (!template) return '';

    const fallbackMap = options?.fallbackMap ?? {};
    const defaultFallback = options?.defaultFallback ?? '';

    return template.replace(TOKEN_REGEX, (_match, path: string) => {
      const resolved = this.resolvePath(data, path);
      if (resolved !== undefined && resolved !== null) {
        return String(resolved);
      }

      if (fallbackMap[path] !== undefined) return fallbackMap[path];

      this.logger.debug(
        `[Template] Unresolved token "{{${path}}}" — rendering "${defaultFallback}"`,
      );
      return defaultFallback;
    });
  }

  /**
   * Report which tokens a template cannot resolve against given data.
   * Used by the dry run to warn an author before anything is sent.
   */
  validate(
    template: string,
    sampleData: Record<string, any>,
  ): {
    valid: boolean;
    unresolvedTokens: string[];
    totalTokens: number;
  } {
    if (!template) return { valid: true, unresolvedTokens: [], totalTokens: 0 };

    const tokens: string[] = [];
    const unresolvedTokens: string[] = [];

    // A fresh RegExp: TOKEN_REGEX is module-level and stateful with /g, so
    // reusing it across calls would resume from the previous lastIndex.
    const regex = new RegExp(TOKEN_REGEX.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(template)) !== null) {
      const path = match[1];
      tokens.push(path);
      const resolved = this.resolvePath(sampleData, path);
      if (resolved === undefined || resolved === null) {
        unresolvedTokens.push(path);
      }
    }

    return {
      valid: unresolvedTokens.length === 0,
      unresolvedTokens,
      totalTokens: tokens.length,
    };
  }

  /**
   * Resolve a dot-delimited path against a data object.
   * Returns undefined if any segment is missing.
   */
  private resolvePath(data: Record<string, any>, path: string): any {
    let value: any = data;
    for (const key of path.split('.')) {
      if (value === undefined || value === null) return undefined;
      if (UNSAFE_KEYS.has(key)) return undefined;
      value = value[key];
    }
    return value;
  }
}
