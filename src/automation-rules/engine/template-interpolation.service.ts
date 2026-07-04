import { Injectable, Logger } from '@nestjs/common';

/**
 * TemplateInterpolationService — safe template parser for automation actions.
 *
 * Resolves {{fieldName}} and {{nested.path.field}} tokens in templates
 * using record data. Provides null-safe fallback values to prevent
 * broken emails/SMS when data is missing.
 *
 * Security: ONLY supports field lookup — no code execution, no expressions.
 */
@Injectable()
export class TemplateInterpolationService {
  private readonly logger = new Logger(TemplateInterpolationService.name);

  /**
   * Default fallback map for common fields that should never render as blank.
   * E.g. "Quý khách" for name fields when addressing unknown recipients.
   */
  private readonly DEFAULT_FALLBACK_MAP: Record<string, string> = {
    Name: 'Quý khách',
    name: 'Quý khách',
    firstName: 'Quý khách',
    lastName: '',
    'Lead.Name': 'Quý khách',
    'Contact.Name': 'Quý khách',
    'Contact.firstName': 'Quý khách',
  };

  /**
   * Regex for matching template tokens: {{fieldName}} or {{Module.Field.Path}}
   * Only allows alphanumeric chars, underscores, and dots (no JS injection risk).
   */
  private readonly TOKEN_REGEX = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

  /**
   * Interpolate a template string with record data.
   *
   * @param template - String containing {{token}} placeholders
   * @param data - Record data to resolve tokens against
   * @param options - Fallback configuration
   * @returns Interpolated string with all tokens resolved
   *
   * @example
   * interpolate('Hello {{firstName}}!', { firstName: 'John' })
   * // → 'Hello John!'
   *
   * interpolate('Hello {{Lead.Name}}!', {}, { fallbackMap: { 'Lead.Name': 'Quý khách' } })
   * // → 'Hello Quý khách!'
   */
  interpolate(
    template: string,
    data: Record<string, any>,
    options?: {
      /** Custom fallback values for specific token paths */
      fallbackMap?: Record<string, string>;
      /** Default fallback for any unresolved token (default: '') */
      defaultFallback?: string;
    },
  ): string {
    if (!template) return '';

    const fallbackMap = {
      ...this.DEFAULT_FALLBACK_MAP,
      ...(options?.fallbackMap || {}),
    };
    const defaultFallback = options?.defaultFallback ?? '';

    return template.replace(this.TOKEN_REGEX, (match, path: string) => {
      // Resolve dot-path: "Lead.address.city" → data.Lead?.address?.city
      const resolved = this.resolvePath(data, path);

      if (resolved !== undefined && resolved !== null) {
        return String(resolved);
      }

      // Try fallback map (exact path match)
      if (fallbackMap[path] !== undefined) {
        return fallbackMap[path];
      }

      // Try fallback map with just the last segment (e.g. "Name" from "Lead.Name")
      const lastSegment = path.split('.').pop() || path;
      if (fallbackMap[lastSegment] !== undefined) {
        return fallbackMap[lastSegment];
      }

      this.logger.debug(
        `[Template] Unresolved token "{{${path}}}" — using fallback "${defaultFallback}"`,
      );
      return defaultFallback;
    });
  }

  /**
   * Validate a template — return list of tokens that cannot be resolved.
   * Used by frontend to preview templates before saving.
   *
   * @param template - Template string to validate
   * @param sampleData - Sample record data to test against
   * @returns Validation result with unresolved token list
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

    let match: RegExpExecArray | null;
    const regex = new RegExp(this.TOKEN_REGEX.source, 'g');

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
   * E.g. "address.city" resolves data.address.city
   *
   * Returns undefined if any segment in the path is missing.
   */
  private resolvePath(data: Record<string, any>, path: string): any {
    const keys = path.split('.');
    let value: any = data;

    for (const key of keys) {
      if (value === undefined || value === null) return undefined;
      // SECURITY: Block prototype pollution vectors
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        return undefined;
      value = value[key];
    }

    return value;
  }
}
