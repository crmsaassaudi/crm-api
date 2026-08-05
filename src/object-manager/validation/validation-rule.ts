/**
 * The tenant's declarative field validation rules, and how they evaluate.
 *
 * Why this moved to the server
 *
 * These rules existed only as a `validate:` callback inside react-hook-form. The
 * `validation_rules` settings document had no reader anywhere in the API, so every
 * write path that is not a person typing into a form ignored them entirely: the
 * REST API, CSV import, automation actions, workflow record updates, and the omni
 * auto-create-contact path. A tenant's "email must match this pattern" rule held
 * for the form and for nothing else, which is worse than not having it — the data
 * looks validated.
 *
 * Kept free of Nest so the semantics can be tested directly, and so they can be
 * stated once and matched exactly by the client. The web's `validateField` is the
 * mirror of this file; `validation-rule.parity.spec.ts` pins the cases where they
 * must agree.
 */

export const RULE_OPERATORS = ['not_empty', 'regex', 'range'] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export interface ValidationRule {
  id: string;
  name: string;
  /** Field key. May be a payload key, a column key, or a pre-split legacy alias. */
  field: string;
  operator: RuleOperator;
  /** Operator argument: a pattern for `regex`, a `min-max` range, unused otherwise. */
  value?: string;
  errorMessage: string;
  isActive?: boolean;
}

/** `validation_rules` as stored: rules bucketed by object name. */
export interface StoredValidationRules {
  rules?: Record<string, ValidationRule[]>;
}

/**
 * Ceilings on a tenant-supplied pattern.
 *
 * A settings screen that accepts a regex accepts a denial of service unless the
 * pattern is bounded: catastrophic backtracking on a 40-character input is enough
 * to pin a worker. Node offers no regex timeout, so the defence has to be static
 * (reject patterns shaped like a backtracking bomb) plus an input bound (cap the
 * subject length). Both mirror the limits the web already applies, so a rule that
 * runs in the browser runs here and vice versa.
 */
const MAX_PATTERN_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 4096;

/** Nested quantifiers and stacked groups — the classic backtracking shapes. */
const DANGEROUS_PATTERN =
  /(?:\(\?[^)]*\).*){5}|[\\][wdsSWD]*[+*]{2}|\([^)]*[+*]\)[+*]/;

export const isUnsafePattern = (pattern: string | undefined): boolean =>
  !pattern ||
  pattern.length > MAX_PATTERN_LENGTH ||
  DANGEROUS_PATTERN.test(pattern);

/**
 * Parse a `min-max` range without breaking on negative bounds.
 *
 * `'-10-5'.split('-')` yields `['', '10', '5']`, so the web's implementation read
 * the minimum as 0 and silently accepted values it should have rejected. Splitting
 * on a hyphen that is not a sign keeps `-10-5`, `1-10` and `5-` all meaning what
 * they look like.
 */
export const parseRange = (
  raw: string | undefined,
): { min: number; max: number } => {
  const parts = String(raw ?? '')
    .trim()
    .split(/(?<=[^-\s])\s*-\s*/);

  const min = parts[0]?.trim() ? Number(parts[0]) : Number.NEGATIVE_INFINITY;
  const max =
    parts.length > 1 && parts[1]?.trim()
      ? Number(parts[1])
      : Number.POSITIVE_INFINITY;

  return {
    min: Number.isFinite(min) ? min : Number.NEGATIVE_INFINITY,
    max: Number.isFinite(max) ? max : Number.POSITIVE_INFINITY,
  };
};

export interface RuleViolation {
  field: string;
  message: string;
  ruleId: string;
}

/**
 * Evaluate one rule against one value.
 *
 * Returns the rule's own error message on failure, so the caller reports exactly
 * what the tenant wrote. A malformed rule — unparseable or unsafe pattern — passes
 * rather than failing the write: a broken rule is an admin's mistake to fix, and
 * turning it into a hard block would let one bad settings row stop every create in
 * the module.
 */
export const evaluateRule = (
  rule: ValidationRule,
  value: unknown,
): string | null => {
  const subject =
    value === null || value === undefined
      ? ''
      : String(value).slice(0, MAX_SUBJECT_LENGTH);

  switch (rule.operator) {
    case 'not_empty':
      return subject.trim() ? null : rule.errorMessage;

    case 'regex': {
      // An empty value is the `not_empty` rule's business. A pattern check on a
      // field the user left blank would make every optional field mandatory the
      // moment a format rule is added to it.
      if (!subject) return null;
      if (isUnsafePattern(rule.value)) return null;
      try {
        return new RegExp(rule.value as string).test(subject)
          ? null
          : rule.errorMessage;
      } catch {
        return null;
      }
    }

    case 'range': {
      if (value === null || value === undefined || subject === '') return null;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return rule.errorMessage;
      const { min, max } = parseRange(rule.value);
      return numeric >= min && numeric <= max ? null : rule.errorMessage;
    }

    default:
      return null;
  }
};
