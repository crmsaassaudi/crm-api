import { SearchEngine } from './search-engine';

/**
 * Each engine paginates in its own currency: OpenSearch hands back a
 * base64url-encoded `search_after` triple, the MongoDB engine hands back a page
 * number. The router is free to switch engines between two pages — that is the
 * whole point of the circuit breaker — so an untagged cursor was being handed to
 * whichever engine happened to answer next. `Number("WzEuOCwi...")` is `NaN`,
 * which `findAll` turns back into page 1, and the page number that came out of
 * that ("NaN") then made OpenSearch reject the following request outright.
 *
 * Tagging the cursor with the engine that minted it makes the mismatch
 * detectable, which is all the router needs to recover deliberately instead of
 * repeating a page and then failing.
 */
const PREFIX: Record<SearchEngine['name'], string> = {
  opensearch: 'os',
  mongodb: 'mg',
};

const BY_PREFIX = new Map<string, SearchEngine['name']>(
  Object.entries(PREFIX).map(([engine, prefix]) => [
    prefix,
    engine as SearchEngine['name'],
  ]),
);

export interface EngineCursor {
  engine: SearchEngine['name'];
  cursor: string;
}

export const encodeEngineCursor = (
  engine: SearchEngine['name'],
  cursor: string,
): string => `${PREFIX[engine]}:${cursor}`;

/**
 * Returns null for anything this build did not mint — an untagged cursor from a
 * client that is mid-deploy, or a truncated one. The caller treats that exactly
 * like an engine mismatch.
 */
export const decodeEngineCursor = (
  raw: string | undefined,
): EngineCursor | null => {
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const engine = BY_PREFIX.get(raw.slice(0, separator));
  const cursor = raw.slice(separator + 1);
  if (!engine || !cursor) return null;
  return { engine, cursor };
};
