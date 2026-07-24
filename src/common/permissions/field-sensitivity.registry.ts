import { PermissionAction, PermissionResource } from './permission.constants';

/**
 * Field-sensitivity classification — permission-driven PII/financial masking.
 *
 * This is distinct from the existing layout-based DataMaskingInterceptor (which
 * masks UI columns per group). Here a field is masked UNLESS the acting
 * principal holds a specific "unmask" permission — the classification is a
 * security control, not a presentation preference. AI-agent principals are
 * always masked regardless of grant (PII must not flow to autonomous actors
 * unless a human is in the loop).
 */

export type SensitivityClass = 'pii' | 'financial';
export type MaskStrategy = 'email' | 'phone' | 'last4' | 'full';

export interface SensitiveField {
  field: string;
  classification: SensitivityClass;
  strategy: MaskStrategy;
  /** The permission that reveals the field unmasked, as (resource, action). */
  unmask: { resource: PermissionResource; action: PermissionAction };
}

/**
 * Per-resource sensitive-field map. Keyed by the resource token passed to
 * `@SensitiveResource(...)`. Extend as new PII/financial fields appear.
 */
export const FIELD_SENSITIVITY: Record<string, SensitiveField[]> = {
  contacts: [
    {
      field: 'email',
      classification: 'pii',
      strategy: 'email',
      unmask: { resource: 'contacts', action: 'unmask' },
    },
    {
      field: 'phone',
      classification: 'pii',
      strategy: 'phone',
      unmask: { resource: 'contacts', action: 'unmask' },
    },
  ],
};

/** Apply a masking strategy to a single string value. Idempotent. */
export function applyMask(value: string, strategy: MaskStrategy): string {
  if (!value || value.includes('•')) return value;
  switch (strategy) {
    case 'email': {
      const at = value.indexOf('@');
      if (at <= 0) return maskFull(value);
      const name = value.slice(0, at);
      const domain = value.slice(at);
      const head = name.slice(0, 1);
      return `${head}${'•'.repeat(Math.max(name.length - 1, 1))}${domain}`;
    }
    case 'phone':
    case 'last4': {
      const digits = value.replace(/\s/g, '');
      if (digits.length <= 4) return '••••';
      return '••••' + digits.slice(-4);
    }
    case 'full':
    default:
      return maskFull(value);
  }
}

function maskFull(value: string): string {
  return '•'.repeat(Math.max(value.length, 4));
}

/** Mask a scalar or array-of-strings field value in place-safe fashion. */
export function maskValue(value: unknown, strategy: MaskStrategy): unknown {
  if (typeof value === 'string') return applyMask(value, strategy);
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? applyMask(v, strategy) : v));
  }
  return value;
}
