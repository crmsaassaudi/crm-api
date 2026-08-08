/**
 * Merge-tag substitution for campaign content.
 *
 * `{{firstName}}` and `{{firstName|there}}` — a whitelisted token, with an
 * optional fallback after the pipe.
 *
 * The whitelist is the whole security model. Interpolating arbitrary paths from
 * the contact document would let whoever writes the campaign body read fields
 * the field-level masking rules hide from them (and, on a populated document,
 * walk into unrelated collections). A token that is not on this list is left
 * exactly as written, so a typo shows up in a test send instead of quietly
 * blanking.
 */
export const MERGE_TOKENS = [
  'firstName',
  'lastName',
  'fullName',
  'companyName',
] as const;

export type MergeToken = (typeof MERGE_TOKENS)[number];

export interface PersonalisationSource {
  firstName?: string;
  lastName?: string;
  companyName?: string;
}

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g;

/** Build the value table once per recipient, then reuse it for every field. */
export function buildMergeValues(
  contact: PersonalisationSource,
): Record<MergeToken, string> {
  const firstName = (contact.firstName ?? '').trim();
  const lastName = (contact.lastName ?? '').trim();
  return {
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' '),
    companyName: (contact.companyName ?? '').trim(),
  };
}

export function personalise(
  template: string,
  values: Record<MergeToken, string>,
): string {
  return template.replace(TOKEN_PATTERN, (whole, name: string, fallback) => {
    if (!isMergeToken(name)) return whole;
    const value = values[name];
    if (value) return value;
    return fallback === undefined ? '' : String(fallback).trim();
  });
}

function isMergeToken(name: string): name is MergeToken {
  return (MERGE_TOKENS as readonly string[]).includes(name);
}
