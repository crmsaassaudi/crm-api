import { Injectable, Logger } from '@nestjs/common';
import { TemplatePurpose } from '../domain/message-template';
import {
  TemplateVariableDefinition,
  isKnownStrictPath,
  variablesForPurpose,
} from '../domain/template-variable-definitions';

/**
 * `{{contact.firstName}}` or `{{contact.firstName|there}}` — dot-path
 * resolution (from the old automation `TemplateInterpolationService`) plus a
 * pipe fallback (from the old campaign `personalise.ts`). One engine replaces
 * both.
 */
const TOKEN_REGEX = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g;

/** Path segments that would reach through to the prototype chain. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type RenderMode = 'strict' | 'broad';

export interface RenderOptions {
  /**
   * 'strict' — token must be in the declarative registry for `purpose`
   * (agent_reply / campaign / bot). 'broad' — any dot-path against `data` is
   * allowed (automation's existing behaviour against arbitrary trigger-object
   * fields; unchanged from before this service existed, on purpose — narrowing
   * it would risk breaking live workflows).
   */
  mode: RenderMode;
  purpose?: TemplatePurpose;
}

export interface ValidationResult {
  valid: boolean;
  unknownTokens: string[];
}

@Injectable()
export class TemplateVariableRegistryService {
  private readonly logger = new Logger(TemplateVariableRegistryService.name);

  /** The strict-mode catalogue for a given purpose — what the frontend's variable picker offers. */
  listVariables(purpose: TemplatePurpose): TemplateVariableDefinition[] {
    return variablesForPurpose(purpose);
  }

  /**
   * Blocks a save, not a send: strict-mode content may only reference tokens
   * in the registry for its purpose. Automation's broad mode has nothing to
   * validate against (any trigger field is legitimate), so it always passes.
   */
  validate(template: string, options: RenderOptions): ValidationResult {
    if (!template || options.mode === 'broad') {
      return { valid: true, unknownTokens: [] };
    }
    if (!options.purpose) {
      throw new Error('validate() requires a purpose in strict mode');
    }
    const unknownTokens = new Set<string>();
    const regex = new RegExp(TOKEN_REGEX.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(template)) !== null) {
      const path = match[1];
      if (!isKnownStrictPath(path, options.purpose)) {
        unknownTokens.add(path);
      }
    }
    return { valid: unknownTokens.size === 0, unknownTokens: [...unknownTokens] };
  }

  /**
   * Renders `{{path}}`/`{{path|fallback}}` tokens against `data`.
   *
   * Unresolved token → the `|fallback` text if given, else empty string. In
   * strict mode this should rarely trigger in practice because `validate()`
   * blocks unknown tokens at save time; it stays defined here as the safe
   * behaviour for legacy/edge content, since showing a customer literal
   * `{{contact.firstName}}` reads worse than "Hi ,".
   */
  render(
    template: string,
    data: Record<string, any>,
    options: RenderOptions = { mode: 'broad' },
  ): string {
    if (!template) return '';
    return template.replace(TOKEN_REGEX, (_whole, path: string, fallback?: string) => {
      if (options.mode === 'strict') {
        if (!options.purpose || !isKnownStrictPath(path, options.purpose)) {
          return fallback === undefined ? '' : String(fallback).trim();
        }
      }
      const resolved = this.resolvePath(data, path);
      if (resolved !== undefined && resolved !== null && resolved !== '') {
        return String(resolved);
      }
      if (fallback !== undefined) return String(fallback).trim();
      this.logger.debug(`[Template] Unresolved token "{{${path}}}" — rendering empty`);
      return '';
    });
  }

  /**
   * Broad-mode-only: "which tokens in this template can't resolve against this
   * sample record?" Used by the automation dry run to warn an author before a
   * workflow saves — `{{contct.name}}` (typo) would otherwise render as empty
   * text with nothing in the execution log explaining why. Not a security
   * check (that's `validate()`, strict-mode only) — just resolvability.
   */
  checkResolution(
    template: string,
    sampleData: Record<string, any>,
  ): { unresolvedTokens: string[]; totalTokens: number } {
    if (!template) return { unresolvedTokens: [], totalTokens: 0 };
    const tokens: string[] = [];
    const unresolvedTokens: string[] = [];
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
    return { unresolvedTokens, totalTokens: tokens.length };
  }

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
