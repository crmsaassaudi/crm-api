import { Schema } from 'mongoose';
import { buildSearchKeys, phoneTokens } from './search-normalizer';

/**
 * Maintains a `searchKeys` array on a document so free-text search can be
 * served from a B-tree instead of a collection scan.
 *
 * The problem it replaces
 * ----------------------
 * Five list views implemented free-text search five ways, and none of them
 * could use an index:
 *
 *   - contacts used `$text`, whose index covered only firstName, lastName and
 *     emails. Whole-word only, so `Ahm` matched nothing and type-ahead did not
 *     exist. Multiple terms were OR-ed, so `nguyen van` returned everyone
 *     matching either half.
 *   - deals, tickets, tasks and accounts used an unanchored case-insensitive
 *     `$regex`. MongoDB can only use an index for a regex that is anchored
 *     *and* case-sensitive, so every keystroke read every live record in the
 *     tenant: measured at 20,000 documents examined and 77-90ms on a 20k
 *     collection, growing linearly from there.
 *
 * Neither could normalise Arabic, which meant `احمد` did not find `أحمد` —
 * two spellings of the same name that Saudi users type interchangeably.
 *
 * How it works
 * ------------
 * Every configured field is folded to canonical tokens by
 * `search-normalizer.ts` and stored in one multikey-indexed array. A query is
 * folded the same way and matched with an **anchored, case-sensitive** prefix
 * regex per token, AND-ed together. That is index-backed, it gives type-ahead,
 * and it makes multi-word queries mean what users think they mean.
 *
 * The trade-off, stated plainly
 * -----------------------------
 * Mid-word matching is lost: `cme` no longer finds `Acme`. deals, tickets and
 * tasks had that property, and it is precisely why they scanned. Mid-word
 * matching is a relevance judgement — tier R — so it belongs to OpenSearch, and
 * it is one of the things a tenant gains when they are switched to it.
 *
 * Write cost
 * ----------
 * MongoDB only touches an index when an indexed field changes. On
 * `omni_conversations` — the hottest document in the system, rewritten on every
 * inbound message — the configured fields are the customer's name and phone,
 * which change during identity resolution and not per message. So this array
 * does not sit on the five-writes-per-message path.
 */

export interface SearchKeysOptions {
  /**
   * Document paths whose text feeds the index. Dotted paths are supported
   * (`relatedTo.name`, `customer.name`).
   */
  fields: string[];
  /**
   * Paths holding phone numbers. Indexed as their digit run as well as their
   * written form, because `+84 (912) 345-678` tokenises into fragments nobody
   * types.
   */
  phoneFields?: string[];
  /**
   * Paths whose content is masked from users without an unmask permission.
   *
   * Kept in a **separate** array rather than folded into `searchKeys`. Field
   * masking stops a user reading a phone number; it did nothing to stop the
   * same user searching for that number and being told which contact owns it.
   * Splitting the arrays is what lets the query side ask for the safe half.
   */
  sensitiveFields?: string[];
  /** Sensitive paths that are phone numbers. */
  sensitivePhoneFields?: string[];
}

export const SEARCH_KEYS_FIELD = 'searchKeys';
export const SEARCH_KEYS_PII_FIELD = 'searchKeysPii';

/** Reads a dotted path out of a plain object or a Mongoose document. */
function readPath(source: any, path: string): unknown {
  if (source == null) return undefined;
  if (typeof source.get === 'function' && !path.includes('.')) {
    // Mongoose documents expose `get`, which resolves defaults and getters.
    const viaGetter = source.get(path);
    if (viaGetter !== undefined) return viaGetter;
  }
  return path
    .split('.')
    .reduce(
      (value: any, segment) => (value == null ? undefined : value[segment]),
      source,
    );
}

/**
 * Primitive leaves of an arbitrary object, so custom field *values* are
 * findable. Bounded depth because `customFields` is `Mixed` and a caller can
 * put anything in it.
 */
function primitiveLeaves(value: unknown, depth = 0): unknown[] {
  if (value == null || depth > 3) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => primitiveLeaves(entry, depth + 1));
  }
  if (value instanceof Date) return [];
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      primitiveLeaves(entry, depth + 1),
    );
  }
  if (typeof value === 'boolean') return [];
  return [value];
}

function collect(source: any, options: SearchKeysOptions) {
  const plain: unknown[] = [];
  const pii: unknown[] = [];

  for (const path of options.fields) {
    const value = readPath(source, path);
    // `customFields` is Mixed: walk it rather than stringifying the object,
    // which would index the key names and the JSON punctuation.
    plain.push(
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? primitiveLeaves(value)
        : value,
    );
  }
  for (const path of options.phoneFields ?? []) {
    const value = readPath(source, path);
    const entries = Array.isArray(value) ? value : [value];
    plain.push(
      entries,
      entries.flatMap((entry) => phoneTokens(entry)),
    );
  }
  for (const path of options.sensitiveFields ?? []) {
    pii.push(readPath(source, path));
  }
  for (const path of options.sensitivePhoneFields ?? []) {
    const value = readPath(source, path);
    const entries = Array.isArray(value) ? value : [value];
    pii.push(
      entries,
      entries.flatMap((entry) => phoneTokens(entry)),
    );
  }

  return {
    keys: buildSearchKeys(plain),
    pii: buildSearchKeys(pii),
  };
}

/**
 * Recomputes the arrays from a document-shaped source.
 *
 * Exported so bulk paths (import, backfill, `bulkWrite`) can produce the same
 * arrays without going through a Mongoose document — a bulk insert that skips
 * this leaves records that exist and cannot be found, which is worse than a
 * record that does not exist.
 */
export function computeSearchKeys(
  source: Record<string, any>,
  options: SearchKeysOptions,
): { searchKeys: string[]; searchKeysPii: string[] } {
  const { keys, pii } = collect(source, options);
  return { searchKeys: keys, searchKeysPii: pii };
}

export function searchKeysPlugin(
  schema: Schema,
  options: SearchKeysOptions,
): void {
  schema.add({
    [SEARCH_KEYS_FIELD]: { type: [String], default: undefined, select: false },
    [SEARCH_KEYS_PII_FIELD]: {
      type: [String],
      default: undefined,
      select: false,
    },
  } as any);

  // `select: false` above keeps both arrays out of every API response. They are
  // an index, not content, and shipping them would leak the masked half.

  schema.index(
    { tenantId: 1, [SEARCH_KEYS_FIELD]: 1 },
    { name: 'search_keys_lookup' },
  );
  schema.index(
    { tenantId: 1, [SEARCH_KEYS_PII_FIELD]: 1 },
    { name: 'search_keys_pii_lookup' },
  );

  const watched = [
    ...options.fields,
    ...(options.phoneFields ?? []),
    ...(options.sensitiveFields ?? []),
    ...(options.sensitivePhoneFields ?? []),
  ];

  schema.pre('save', function (next) {
    const self = this as any;
    // Recompute only when something that feeds the arrays actually changed.
    // Otherwise every unrelated `save()` — and on a conversation that is every
    // inbound message — would rewrite two indexed arrays.
    const touched =
      self.isNew || watched.some((path: string) => self.isModified(path));
    if (touched) {
      const computed = computeSearchKeys(self, options);
      self[SEARCH_KEYS_FIELD] = computed.searchKeys;
      self[SEARCH_KEYS_PII_FIELD] = computed.searchKeysPii;
    }
    next();
  });

  const recomputeOnUpdate = function (this: any, next: (err?: any) => void) {
    const update = this.getUpdate();
    if (!update || Array.isArray(update)) return next();

    const set = { ...(update.$set ?? {}), ...update } as Record<string, any>;
    delete set.$set;
    delete set.$setOnInsert;

    const changed = watched.some((path) =>
      Object.keys(set).some(
        (key) => key === path || key.startsWith(`${path}.`) || path === key,
      ),
    );
    // An update that does not touch a watched field leaves the arrays alone.
    // An upsert always recomputes: on insert there is nothing to leave alone.
    const upserting = this.getOptions?.()?.upsert === true;
    if (!changed && !upserting) return next();

    // Merge the update over the current document so nested and partial updates
    // see the same shape a full document would. `$set` of one field must not
    // wipe keys derived from the fields it did not touch.
    void this.model
      .findOne(this.getFilter())
      .lean()
      .setOptions({ isPlatformQuery: this.getOptions?.()?.isPlatformQuery })
      .then((current: any) => {
        const merged = { ...(current ?? {}) };
        for (const [key, value] of Object.entries(set)) {
          if (key.startsWith('$')) continue;
          if (key.includes('.')) {
            const segments = key.split('.');
            let cursor: any = merged;
            for (const segment of segments.slice(0, -1)) {
              cursor[segment] = cursor[segment] ?? {};
              cursor = cursor[segment];
            }
            cursor[segments.at(-1)!] = value;
          } else {
            merged[key] = value;
          }
        }
        const computed = computeSearchKeys(merged, options);
        this.set(SEARCH_KEYS_FIELD, computed.searchKeys);
        this.set(SEARCH_KEYS_PII_FIELD, computed.searchKeysPii);
        next();
      })
      .catch(next);
  };

  schema.pre('findOneAndUpdate', recomputeOnUpdate);
  schema.pre('updateOne', recomputeOnUpdate);
}
