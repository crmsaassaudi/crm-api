/**
 * Escape regex metacharacters in untrusted input before using it in a
 * Mongo `$regex` expression. Prevents both syntactic breakage and catastrophic
 * backtracking (ReDoS) caused by attacker-controlled patterns like `(a+)+$`.
 *
 * The length cap keeps the worst case bounded — even a fully escaped pattern
 * over very long input can be costly to scan.
 */
const MAX_SEARCH_LENGTH = 100;

export function escapeRegex(value: string): string {
  return String(value)
    .slice(0, MAX_SEARCH_LENGTH)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
