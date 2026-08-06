import { PermissionAction, PermissionResource } from './permission.constants';

/**
 * Field-sensitivity classification — permission-driven PII/financial masking.
 *
 * This is distinct from the layout-based FieldPolicyInterceptor (which
 * masks UI columns per group). Here a field is masked UNLESS the acting
 * principal holds a specific "unmask" permission — the classification is a
 * security control, not a presentation preference. AI-agent principals are
 * always masked regardless of grant (PII must not flow to autonomous actors
 * unless a human is in the loop).
 */

export type SensitivityClass = 'pii' | 'financial';
export type MaskStrategy =
  | 'email'
  | 'phone'
  | 'last4'
  | 'full'
  | 'redact-number';

export interface SensitiveField {
  field: string;
  classification: SensitivityClass;
  strategy: MaskStrategy;
  /** The permission that reveals the field unmasked, as (resource, action). */
  unmask: { resource: PermissionResource; action: PermissionAction };
}

/**
 * Per-resource sensitive-field map. Keyed by the resource token passed to
 * `@SensitiveResource(...)`.
 *
 * `field` MUST be the name as it appears in the SERIALISED response, not the
 * conceptual name. Contacts store `emails: string[]` / `phones: string[]`; this
 * registry previously declared the singular `email`/`phone`, so
 * `FieldMaskingInterceptor.maskItem` looked up `target['email']`, found
 * `undefined`, and masked nothing — the whole permission-driven control was
 * inert for the one resource it existed to protect, and CI stayed green because
 * the spec fed it a hand-built `{ email: ... }` object rather than a contact.
 * The specs below the fix now assert against the real field names.
 */
export const FIELD_SENSITIVITY: Record<string, SensitiveField[]> = {
  contacts: [
    {
      field: 'emails',
      classification: 'pii',
      strategy: 'email',
      unmask: { resource: 'contacts', action: 'unmask' },
    },
    {
      field: 'phones',
      classification: 'pii',
      strategy: 'phone',
      unmask: { resource: 'contacts', action: 'unmask' },
    },
    // Postal address and date of birth are personal data in their own right —
    // under PDPL and GDPR a home address identifies a person as surely as a
    // phone number does, and a clinic's or a school's records make that
    // concrete. They were left out while emails/phones were protected, so a
    // Read Only or Marketing role saw the address of every customer.
    //
    // Gated on the SAME `contacts:unmask` action already granted to Manager,
    // Sales Rep and Support Agent, so no role loses access it had a use for and
    // no seeding step is required for the control to be liftable.
    {
      field: 'address',
      classification: 'pii',
      strategy: 'full',
      unmask: { resource: 'contacts', action: 'unmask' },
    },
    {
      field: 'birthday',
      classification: 'pii',
      strategy: 'full',
      unmask: { resource: 'contacts', action: 'unmask' },
    },
  ],
  /**
   * Conversations cache the end customer's contact details on a `customer`
   * sub-document. Dotted paths, which `FieldMaskingInterceptor.maskPath` resolves —
   * a flat lookup could not reach these however precisely they were named.
   */
  omni_channel: [
    {
      field: 'customer.email',
      classification: 'pii',
      strategy: 'email',
      unmask: { resource: 'omni_channel', action: 'unmask' },
    },
    {
      field: 'customer.phone',
      classification: 'pii',
      strategy: 'phone',
      unmask: { resource: 'omni_channel', action: 'unmask' },
    },
  ],
  /**
   * `value`/`probability` had NO field-level control at all — any principal
   * holding base `deals:view` saw the full amount and computed forecast.
   * `deals:unmask` ships in CORE_PERMISSIONS so no existing Owner/Admin loses
   * access; a tenant can now withhold it from a specific custom role, which
   * was previously impossible.
   */
  deals: [
    {
      field: 'value',
      classification: 'financial',
      strategy: 'redact-number',
      unmask: { resource: 'deals', action: 'unmask' },
    },
    {
      field: 'probability',
      classification: 'financial',
      strategy: 'redact-number',
      unmask: { resource: 'deals', action: 'unmask' },
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

/**
 * Mask a scalar, number, or array-of-strings field value in place-safe
 * fashion.
 *
 * `typeof value === 'string'` and `Array.isArray` were the only branches —
 * a numeric field (deal `value`/`probability`) fell through untouched, so a
 * tenant admin who configured masking for it got no masking at all, silently.
 * `redact-number` returns `null` rather than a string, since callers (list
 * views, exports) expect the field's type to stay a number-or-null, not
 * become `'•••'`.
 *
 * A `Date` is redacted to `null` under `full` for the same reason a number is:
 * there is no dotted form of a date that stays a date, and returning the value
 * unchanged would make a registered field silently unmasked — a control that
 * reads as active and is not.
 */
export function maskValue(value: unknown, strategy: MaskStrategy): unknown {
  if (strategy === 'redact-number') {
    return typeof value === 'number' ? null : value;
  }
  if (typeof value === 'string') return applyMask(value, strategy);
  if (value instanceof Date) return strategy === 'full' ? null : value;
  if (Array.isArray(value)) {
    return value.map((v) =>
      typeof v === 'string' ? applyMask(v, strategy) : v,
    );
  }
  return value;
}
