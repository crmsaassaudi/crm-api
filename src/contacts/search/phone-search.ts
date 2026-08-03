import { normalizePhone } from '../../common/identity/identity-normalizer';

/**
 * Everything a user can type that is still a phone number: digits, the E.164
 * '+', and the separators every UI and every CSV in the world puts between
 * them. Deliberately excludes letters, so "Nguyen 0901" stays a text search.
 */
const PHONE_SHAPED = /^[+\d\s().\-/]+$/;

/**
 * Minimum digits before a numeric string is treated as a phone lookup rather
 * than free text.
 *
 * Four matches the threshold the OpenSearch engine already uses for
 * `phoneSuffixes`, so both engines agree on what counts as a phone query — a
 * user must not get different results depending on which engine served them.
 */
const MIN_PHONE_DIGITS = 4;

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Decide whether `search` is a phone lookup and, if so, produce the literal
 * prefixes to match `contacts.phones` against.
 *
 * Returns null when the term is not phone-shaped — the signal to fall back to
 * text search.
 *
 * Why prefixes, and why exactly these three properties
 *
 * MongoDB can only use an index for a regular expression when it is a *prefix
 * expression* (`^` followed by literals) matched *case-sensitively*. Stored
 * phones are normalised to digits and an optional '+', so there is no case to
 * be insensitive about: omitting `$options: 'i'` costs nothing and is the whole
 * difference between an index scan and reading every contact in the tenant.
 *
 * Equality needs no separate branch — a full-length prefix *is* equality — so
 * one mechanism covers both the pasted-in-full case and partial typing.
 *
 * What this deliberately does NOT do
 *
 * Suffix matching. Someone who types only the last six digits of
 * `+84901112222` cannot be served from a B-tree index: a trailing match is not
 * a prefix, and making it indexable means storing a suffix array (the shape
 * `phoneSuffixes` already has in the search index). Answering that case here
 * would mean a tenant-wide scan — precisely the cost this function exists to
 * remove — so suffix search is left to OpenSearch, where it already works.
 * Everything a caller actually pastes or dials is covered.
 */
export function buildPhoneSearchPrefixes(
  search: string,
  defaultCountryCode?: string,
): string[] | null {
  const term = search.trim();
  if (!term || !PHONE_SHAPED.test(term)) return null;

  const digits = term.replace(/\D/g, '');
  if (digits.length < MIN_PHONE_DIGITS) return null;

  const prefixes = new Set<string>();

  if (term.startsWith('+')) {
    // An explicit '+' is a statement about the format: the user supplied a full
    // international number, so do not invent national variants of it.
    prefixes.add(`+${digits}`);
  } else {
    prefixes.add(digits);
    prefixes.add(`+${digits}`);

    // The case that matters most in practice: the write gate stored E.164
    // (`+84901112222`) and the user types the national form they know
    // (`0901112222`). Only the tenant's country code bridges the two, which is
    // why it is threaded down here rather than guessed.
    const promoted = normalizePhone(term, defaultCountryCode);
    if (promoted) prefixes.add(promoted);
  }

  return [...prefixes];
}

/**
 * Render prefixes as a Mongo filter fragment over `phones`.
 *
 * Returned as a standalone clause for the caller to `$and` into its filter,
 * never assigned onto a shared `$or` key: a later writer assigning `$or` would
 * silently replace this one, which is the failure mode `applyOwnerRestriction`
 * already had to be rewritten to avoid.
 */
export function phoneSearchClause(prefixes: string[]): Record<string, unknown> {
  const branches = prefixes.map((prefix) => ({
    phones: { $regex: `^${escapeRegex(prefix)}` },
  }));
  return branches.length === 1 ? branches[0] : { $or: branches };
}

export const PHONE_SEARCH_MIN_DIGITS = MIN_PHONE_DIGITS;
