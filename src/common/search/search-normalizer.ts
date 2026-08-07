/**
 * The one definition of "what counts as the same string" for search.
 *
 * Two engines answer search questions in this product, and which one answers is
 * a per-tenant decision. That makes string normalisation the single place where
 * they are not allowed to disagree: a VIP tenant moved to OpenSearch must not
 * discover that `احمد` stopped finding `أحمد`. Quality of results may differ
 * between engines — that is what the capability registry declares — but whether
 * two strings are *the same word* may not.
 *
 * So this file is the source, and it feeds two consumers:
 *   - MongoDB, by generating the `searchKeys` array every searchable document
 *     carries (see `search-keys.plugin.ts`);
 *   - OpenSearch, by defining the analyzer chain that
 *     `crm-opensearch/src/index/index-definition.ts` must mirror
 *     (`lowercase → decimal_digit → arabic_normalization → asciifolding`).
 *
 * `search-normalizer.parity.spec.ts` holds both to the same fixture table, and
 * the OpenSearch side of that table runs against a real cluster's `_analyze`.
 *
 * What this deliberately does NOT do
 * ----------------------------------
 * Stemming. Stemming is lossy and language-guessing, and MongoDB has no way to
 * do it per-field-per-language. Matching a stem is a relevance judgement, which
 * is tier R — it belongs to OpenSearch, and pretending MongoDB does it would be
 * the kind of quiet divergence this file exists to prevent.
 */

/**
 * Arabic orthographic variants that native writers use interchangeably.
 *
 * `asciifolding` — the only folding the OpenSearch mapping had — does nothing
 * to Arabic script, so before this existed `احمد` and `أحمد` were two different
 * words to both engines. In a product sold into Saudi Arabia that is not an
 * edge case; it is the common case, because the hamza is routinely omitted when
 * typing.
 *
 * Mirrors OpenSearch's `arabic_normalization` token filter.
 */
const ARABIC_FOLDING: Array<[RegExp, string]> = [
  // Alef with hamza/madda above or below → bare alef.
  [/[آأإٱ]/g, 'ا'],
  // Alef maksura → yeh. (على vs علي)
  [/ى/g, 'ي'],
  // Teh marbuta → heh. (شركة vs شركه)
  [/ة/g, 'ه'],
  // Tatweel: a purely decorative elongation. (محمـــد)
  [/ـ/g, ''],
  // Harakat and other combining marks are removed by the NFKD step below, but
  // superscript alef (U+0670) is a mark that survives some inputs.
  [/ٰ/g, ''],
];

/**
 * Latin letters that NFKD does not decompose but `asciifolding` does fold.
 *
 * NFKD splits a base letter from its combining marks, so `ễ` becomes `e` plus
 * two marks and the marks are then stripped. A letter carrying a *stroke* is
 * not composed that way — `đ` (U+0111) is a single indivisible code point — so
 * NFKD leaves it untouched and `Đà Nẵng` folded to `["đa","nang"]` while
 * OpenSearch produced `["da","nang"]`. The fixture table caught it; without the
 * table the two engines would have disagreed on every Vietnamese name starting
 * with Đ, which is a great many of them.
 *
 * Only the letters `asciifolding` actually folds, so the two sides stay
 * equivalent by construction rather than by coincidence.
 */
const LATIN_FOLDING: Array<[RegExp, string]> = [
  [/[đĐ]/g, 'd'],
  [/[øØ]/g, 'o'],
  [/[łŁ]/g, 'l'],
  [/[æÆ]/g, 'ae'],
  [/[œŒ]/g, 'oe'],
  [/ß/g, 'ss'],
  [/[þÞ]/g, 'th'],
  [/[ðÐ]/g, 'd'],
  [/ı/g, 'i'],
];

/**
 * Arabic-Indic and Extended Arabic-Indic digits → ASCII.
 *
 * Mirrors OpenSearch's `decimal_digit` filter, and must run *before*
 * tokenisation: a phone number typed as `٠٥٠١٢٣٤٥٦٧` has to become digits
 * before anything decides whether it is a word or a number.
 */
const foldDigits = (value: string): string =>
  value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.codePointAt(0)!;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });

/** Shortest token worth indexing. One-character tokens match almost everything. */
export const MIN_TOKEN_LENGTH = 2;

/**
 * Upper bound on tokens per document.
 *
 * `searchKeys` is a multikey index: every entry is an index entry, so an
 * unbounded array is unbounded write amplification on the collection's hottest
 * path.
 *
 * The cap applies in **field order**, so {@link buildSearchKeys} must fill the
 * set before sorting it. Sorting first and slicing second keeps the sixty tokens
 * nearest the start of the *alphabet*, not of the *record*: a long description
 * then loses everything from roughly `q` onwards, and "zenith" finds nothing
 * while "acme" works. Callers list fields in priority order, which is the
 * ranking that matters; spelling is not.
 */
export const MAX_SEARCH_KEYS = 60;

/**
 * Fold a string to its canonical searchable form, without splitting it.
 *
 * Used for the query side when the caller already knows it holds one token, and
 * by {@link searchTokens} internally.
 */
export function foldSearchText(value: string): string {
  let folded = value
    // NFKD splits a precomposed character into base + combining marks…
    .normalize('NFKD')
    // …and this removes the marks. Doing only the first half — which is what
    // the ranking helper used to do — leaves "nguyễn" as base letters *plus*
    // marks, so it still fails to match "nguyen": the record comes back from
    // the database correctly and then scores zero.
    .replace(/\p{M}+/gu, '');

  folded = foldDigits(folded);
  for (const [pattern, replacement] of ARABIC_FOLDING) {
    folded = folded.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of LATIN_FOLDING) {
    folded = folded.replace(pattern, replacement);
  }
  // `toLowerCase`, not `toLocaleLowerCase`: the locale-aware variant depends on
  // the server's locale, which would make the index contents depend on where
  // the process runs.
  return folded.toLowerCase();
}

/**
 * Split arbitrary text into the canonical tokens used for search.
 *
 * Splitting on "not a letter and not a number" means `Al-Rashid` becomes
 * `["al","rashid"]` and `+966 50 123 4567` becomes `["966","50","123","4567"]`,
 * which is what a person typing either fragment expects to match.
 */
export function searchTokens(value: unknown): string[] {
  if (value == null) return [];
  const folded = foldSearchText(String(value));
  const tokens = folded.split(/[^\p{L}\p{N}]+/u);
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length >= MIN_TOKEN_LENGTH) out.push(token);
  }
  return out;
}

/**
 * Digits-only variants of a phone-ish value, for matching numbers as they are
 * dialled rather than as they are punctuated.
 *
 * `+84 (912) 345-678` tokenises into fragments nobody types. The digit run is
 * what a user actually enters, so it is indexed alongside them.
 */
export function phoneTokens(value: unknown): string[] {
  if (value == null) return [];
  const digits = foldDigits(String(value)).replace(/\D+/g, '');
  return digits.length >= 4 ? [digits] : [];
}

/**
 * Build the `searchKeys` array for a document from an arbitrary set of values.
 *
 * Deduplicated, capped in the order the values arrive, and only then sorted.
 * Sorting is for byte-stability — two documents with the same searchable content
 * produce identical arrays — and must happen *after* the cap, not before; see
 * {@link MAX_SEARCH_KEYS}.
 */
export function buildSearchKeys(values: unknown[]): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    if (value == null) continue;
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      for (const token of searchTokens(entry)) {
        keys.add(token);
        if (keys.size >= MAX_SEARCH_KEYS) return [...keys].sort();
      }
    }
  }
  return [...keys].sort();
}

/**
 * The tokens a user's query should be matched by.
 *
 * Returns an empty array for a query that carries no usable token, and callers
 * must treat that as "no search constraint" rather than "match nothing" — a
 * one-character query is a query the user is still typing.
 */
export function queryTokens(query: string): string[] {
  return [...new Set(searchTokens(query))].slice(0, 8);
}
