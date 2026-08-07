import { SEARCH_KEYS_FIELD, SEARCH_KEYS_PII_FIELD } from './search-keys.plugin';
import { queryTokens } from './search-normalizer';

/** Escapes a token that is about to become a literal inside a regex. */
const escape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface SearchClauseOptions {
  /**
   * Whether the caller may search the masked half (phones, e-mails).
   *
   * Defaults to **false**. Field masking stops a user reading a contact's
   * phone number; before this, the same user could type that number into the
   * list search and be told whose it is — the protected value used as a lookup
   * key. Making the safe half the default means a caller who forgets to pass
   * this gets the narrower behaviour.
   */
  includeSensitive?: boolean;
}

/**
 * A MongoDB filter fragment matching documents whose `searchKeys` contain a
 * prefix of every token in the query.
 *
 * Returns `null` when the query carries no usable token, which callers must
 * treat as "no search constraint" — a one-character query is a query the user
 * is still typing, not a request for an empty screen.
 *
 * Three properties are load-bearing and must not be relaxed:
 *
 *   1. **Anchored** (`^`). MongoDB uses an index for a regex only when it is a
 *      prefix expression. Drop the anchor and this becomes the collection scan
 *      it was written to remove.
 *   2. **Case-sensitive** (no `$options: 'i'`). The stored keys are already
 *      folded to lower case, so there is no case to be insensitive about, and
 *      adding the flag disqualifies the index just as surely as dropping the
 *      anchor.
 *   3. **AND across tokens.** `$text` OR-ed its terms, so `nguyen van` returned
 *      everyone matching either name. Users read a multi-word query as a
 *      narrowing, and this makes it one.
 */
export function searchKeysClause(
  query: string | undefined | null,
  options: SearchClauseOptions = {},
): Record<string, unknown> | null {
  if (!query) return null;
  const tokens = queryTokens(query);
  if (tokens.length === 0) return null;

  const fields = options.includeSensitive
    ? [SEARCH_KEYS_FIELD, SEARCH_KEYS_PII_FIELD]
    : [SEARCH_KEYS_FIELD];

  const perToken = tokens.map((token) => {
    const expression = { $regex: `^${escape(token)}` };
    // One `$or` per token, not one `$or` overall: every token must match
    // somewhere, but each is free to match a different field.
    return fields.length === 1
      ? { [fields[0]]: expression }
      : { $or: fields.map((field) => ({ [field]: expression })) };
  });

  return perToken.length === 1 ? perToken[0] : { $and: perToken };
}

/**
 * Applies {@link searchKeysClause} to a filter object without stomping on an
 * `$and` a caller has already built.
 *
 * Assigning to `where.$and` directly is how one predicate silently replaces
 * another — a failure mode the owner-restriction path already had to be
 * rewritten to avoid, and one that removes a *security* filter when it happens
 * to a scope clause.
 */
export function applySearchKeys(
  where: Record<string, any>,
  query: string | undefined | null,
  options: SearchClauseOptions = {},
): void {
  const clause = searchKeysClause(query, options);
  if (!clause) return;
  where.$and = [...((where.$and as unknown[]) ?? []), clause];
}
