/**
 * Identity normalisation — the single gate every write path must pass through
 * before an email or phone number reaches storage or a dedup comparison.
 *
 * Why this exists as shared code rather than per-module helpers: before this,
 * the import worker lower-cased emails and stripped phone separators while the
 * REST path stored whatever the client sent. `ContactsService.findByEmail()`
 * lower-cases its probe, so a contact created through the UI as `John@Acme.com`
 * was invisible to the omni inbound resolver — which then created a SECOND
 * contact for the same person. The duplicate was not a dedup-rule failure; the
 * two sides were simply never comparable.
 *
 * Rule: normalise once, at the edge, for every writer. A value that is stored
 * normalised can always be compared; a value that is only normalised at compare
 * time depends on every caller remembering to do it.
 */

/**
 * Normalise an email for storage and comparison.
 *
 * Lower-cases and trims. Deliberately does NOT strip Gmail-style dots or
 * `+tag` suffixes: `a.b@gmail.com` and `ab@gmail.com` are the same mailbox at
 * Google but different mailboxes at most other providers, so folding them would
 * merge two distinct people on any self-hosted domain. Provider-specific
 * canonicalisation belongs in a duplicate *rule*, where a tenant can opt in —
 * not in the storage gate, which must be lossless.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalise a phone number for storage and comparison.
 *
 * Strips every separator but PRESERVES a leading '+', because the '+' is the
 * difference between the E.164 number +84901112222 and the national string
 * 84901112222. WhatsApp and most SMS gateways require E.164, so dropping it
 * makes the contact unsendable — and unrecoverably so once the source CSV is
 * gone.
 *
 * When `defaultCountryCode` is supplied (from the tenant's locale settings) a
 * national-format number is promoted to E.164: a leading trunk '0' is replaced
 * by '+<cc>'. That is what makes a UI-entered `0901112222` comparable with an
 * imported `+84901112222` — the case that previously produced duplicate
 * contacts for the same person.
 */
export function normalizePhone(
  value: string,
  defaultCountryCode?: string,
): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  if (trimmed.startsWith('+')) return `+${digits}`;

  // '00' is the other international prefix (ITU-T E.123) — treat it as '+'.
  if (digits.startsWith('00') && digits.length > 4) {
    return `+${digits.slice(2)}`;
  }

  const cc = (defaultCountryCode ?? '').replace(/\D/g, '');
  if (cc) {
    // National format with a trunk prefix: 0901112222 → +84901112222.
    if (digits.startsWith('0')) return `+${cc}${digits.slice(1)}`;
    // Already carries the country code without a '+': 84901112222.
    if (digits.startsWith(cc)) return `+${digits}`;
    return `+${cc}${digits}`;
  }

  return digits;
}

/** Normalise + de-duplicate a list of emails, dropping empties. */
export function normalizeEmails(values: unknown): string[] {
  return uniqueNonEmpty(asStringArray(values).map(normalizeEmail));
}

/** Normalise + de-duplicate a list of phones, dropping empties. */
export function normalizePhones(
  values: unknown,
  defaultCountryCode?: string,
): string[] {
  return uniqueNonEmpty(
    asStringArray(values).map((v) => normalizePhone(v, defaultCountryCode)),
  );
}

/**
 * Split a multi-value cell (`"a@x.com; b@y.com"`) as import files use.
 * Kept here so the import parser and the API share one definition of
 * "several values in one field".
 */
export function splitMultiValue(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function asStringArray(values: unknown): string[] {
  if (typeof values === 'string') return [values];
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => typeof v === 'string');
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.length > 0)));
}

/**
 * class-transformer `@Transform` handlers. Applied on the DTOs so normalisation
 * happens inside the global ValidationPipe — i.e. before any controller,
 * service or repository can observe the raw value.
 */
export const TransformEmails = ({ value }: { value: unknown }) =>
  value === undefined || value === null ? value : normalizeEmails(value);

export const TransformPhones = ({ value }: { value: unknown }) =>
  value === undefined || value === null ? value : normalizePhones(value);
