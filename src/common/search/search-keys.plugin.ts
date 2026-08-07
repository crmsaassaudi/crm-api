import { Schema } from 'mongoose';
import { buildSearchKeys, phoneTokens } from './search-normalizer';

/**
 * Maintains a `searchKeys` array so free-text search runs on a B-tree instead of
 * a collection scan, folded by `search-normalizer.ts`. Rationale and
 * measurements: `docs/audit/SEARCH_COVERAGE_AUDIT_2026-08-07.md`.
 *
 * One invariant, at every entry point Mongoose offers: **any write touching a
 * watched path recomputes the arrays from the document as it will exist after
 * that write.** `Model.bulkWrite` runs no query middleware and `updateMany`
 * needs one array per document, so both are handled explicitly below. An
 * operator {@link replayUpdate} cannot reproduce throws instead of writing a
 * stale array — a loud failure beats a silent one.
 */

/**
 * Security: the maintenance reads below use the query's own filter, and
 * `tenantFilterPlugin` is applied to every schema **before** this plugin, so
 * Mongoose has already added `tenantId` by the time these hooks run.
 * `search-keys.plugin.spec.ts` pins that ordering — reversing it would turn a
 * maintenance read into a cross-tenant read.
 *
 * Cost: every hook returns before doing any I/O when the update names no watched
 * path. On `omni_conversations` — rewritten on every inbound message — the
 * watched fields are the customer's name and phone, which change during identity
 * resolution and not per message.
 */

export interface SearchKeysOptions {
  /**
   * Document paths whose text feeds the index. Dotted paths are supported
   * (`relatedTo.name`, `customer.name`).
   *
   * Order matters: tokens are collected in this order and capped at
   * `MAX_SEARCH_KEYS`, so list the fields a user is most likely to search by
   * first (a name before a description).
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

/**
 * Ceiling on how many documents one `updateMany` may re-key.
 *
 * Each document needs its own array, so a single update statement cannot carry
 * the values and a second write is unavoidable. Bounding it means a filter that
 * accidentally matches a whole collection fails loudly instead of rewriting it:
 * the widest real caller is "every deal belonging to one account".
 */
const MAX_RECOMPUTE_DOCS = 10_000;

/** Ops per driver `bulkWrite` when re-keying, so one batch stays bounded. */
const REKEY_CHUNK_SIZE = 500;

/** Update operators whose effect on a watched path can be replayed exactly. */
const REPLAYABLE_OPERATORS = new Set([
  '$set',
  '$setOnInsert',
  '$unset',
  '$addToSet',
  '$push',
  '$pull',
  '$pullAll',
]);

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

/** Writes a dotted path into a plain object, creating intermediate objects. */
function writePath(target: Record<string, any>, path: string, value: unknown) {
  const segments = path.split('.');
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  const leaf = segments.at(-1)!;
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
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
 * Exported so bulk paths can produce the same arrays without going through a
 * Mongoose document — a bulk insert that skips this leaves records that exist
 * and cannot be found, which is worse than a record that does not exist.
 */
export function computeSearchKeys(
  source: Record<string, any>,
  options: SearchKeysOptions,
): { searchKeys: string[]; searchKeysPii: string[] } {
  const { keys, pii } = collect(source, options);
  return { searchKeys: keys, searchKeysPii: pii };
}

/** Every path that feeds either array, in priority order. */
export function watchedPaths(options: SearchKeysOptions): string[] {
  return [
    ...options.fields,
    ...(options.phoneFields ?? []),
    ...(options.sensitiveFields ?? []),
    ...(options.sensitivePhoneFields ?? []),
  ];
}

/** Does an update path overlap a watched path, in either direction? */
const overlaps = (path: string, watched: string[]): boolean =>
  watched.some(
    (field) =>
      path === field ||
      // The update reaches inside a watched field (`customer.name.first`)…
      path.startsWith(`${field}.`) ||
      // …or replaces an ancestor of one (`customer` when watching
      // `customer.name`).
      field.startsWith(`${path}.`),
  );

export class SearchKeysReplayError extends Error {}

/**
 * Whether an update touches a watched path, and whether it can be replayed.
 *
 * Every operator in the update is inspected, not just `$set`. That is the whole
 * point: `$addToSet` on `tags` is exactly as much a change to the searchable
 * text of a record as `$set` on its name, and treating it as "no change" is what
 * left bulk-tagged records unfindable by their tags.
 */
export function analyseUpdate(
  update: unknown,
  watched: string[],
): { touched: boolean; unsupported: string[] } {
  if (!update || typeof update !== 'object') {
    return { touched: false, unsupported: [] };
  }
  if (Array.isArray(update)) {
    // An aggregation-pipeline update. Nothing uses one on a searchable
    // collection, and guessing at what a pipeline does to a field is exactly
    // the kind of silent approximation this plugin exists to stop.
    return { touched: true, unsupported: ['aggregation pipeline update'] };
  }

  let touched = false;
  const unsupported: string[] = [];

  for (const [key, value] of Object.entries(update)) {
    if (!key.startsWith('$')) {
      // Mongoose accepts `updateOne(filter, { name: 'x' })` and casts it to
      // `$set` later, i.e. after this hook has run.
      if (overlaps(key, watched)) touched = true;
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const hits = Object.keys(value).filter((path) => overlaps(path, watched));
    if (hits.length === 0) continue;
    touched = true;
    if (!REPLAYABLE_OPERATORS.has(key)) {
      unsupported.push(`${key} on ${hits.join(', ')}`);
    }
  }

  return { touched, unsupported };
}

/** The values `$addToSet`/`$push` will append, unwrapping `$each`. */
const appendedValues = (operand: unknown): unknown[] => {
  if (operand && typeof operand === 'object' && '$each' in (operand as any)) {
    const each = (operand as any).$each;
    return Array.isArray(each) ? each : [each];
  }
  return [operand];
};

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? [...value] : value == null ? [] : [value];

/**
 * The equality conditions of a filter, as a document-shaped object.
 *
 * An upsert that inserts builds the new document from the filter's equality
 * conditions *and* the update, so replaying only the update loses whatever the
 * caller expressed as a filter: `updateOne({ tenantId, title }, { $set: { … } },
 * { upsert: true })` would index everything except the title. Operator operands
 * (`{ $in: [...] }`, `{ $ne: null }`) are skipped — they describe a set of
 * documents, not the values one document will hold.
 */
export function filterEqualities(filter: unknown): Record<string, any> {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return {};
  const equalities: Record<string, any> = {};
  for (const [path, value] of Object.entries(filter as Record<string, any>)) {
    if (path.startsWith('$')) continue;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).some((key) => key.startsWith('$'))
    ) {
      continue;
    }
    writePath(equalities, path, value);
  }
  return equalities;
}

/**
 * A copy of `document` holding only the watched paths.
 *
 * Deliberately not a deep clone of the whole document: it would have to carry
 * ObjectIds and Buffers, and nothing outside these paths can change the arrays.
 */
export function projectWatched(
  document: Record<string, any> | null | undefined,
  watched: string[],
): Record<string, any> {
  const projection: Record<string, any> = {};
  for (const path of watched) {
    const value = readPath(document, path);
    if (value === undefined) continue;
    writePath(projection, path, Array.isArray(value) ? [...value] : value);
  }
  return projection;
}

/**
 * Applies an update to a projected document, so the arrays can be computed from
 * the values the document will hold *after* the write rather than before it.
 *
 * Only the watched paths are replayed — everything else cannot affect the
 * result. Throws on an operator it cannot reproduce: writing an array that is
 * confidently wrong is worse than refusing the write.
 */
export function replayUpdate(
  projected: Record<string, any>,
  update: unknown,
  watched: string[],
): Record<string, any> {
  const analysis = analyseUpdate(update, watched);
  if (analysis.unsupported.length > 0) {
    throw new SearchKeysReplayError(
      `searchKeysPlugin cannot derive searchKeys from ${analysis.unsupported.join(
        '; ',
      )}. Use $set/$unset/$addToSet/$push/$pull, or write the document with save().`,
    );
  }

  for (const [key, value] of Object.entries(
    update as Record<string, unknown>,
  )) {
    if (!key.startsWith('$')) {
      if (overlaps(key, watched)) writePath(projected, key, value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;

    for (const [path, operand] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (!overlaps(path, watched)) continue;

      switch (key) {
        case '$set':
        case '$setOnInsert':
          writePath(projected, path, operand);
          break;
        case '$unset':
          writePath(projected, path, undefined);
          break;
        case '$addToSet': {
          const current = asArray(readPath(projected, path));
          const seen = new Set(current.map((entry) => String(entry)));
          for (const entry of appendedValues(operand)) {
            if (seen.has(String(entry))) continue;
            seen.add(String(entry));
            current.push(entry);
          }
          writePath(projected, path, current);
          break;
        }
        case '$push': {
          const current = asArray(readPath(projected, path));
          current.push(...appendedValues(operand));
          writePath(projected, path, current);
          break;
        }
        case '$pull':
        case '$pullAll': {
          const current = asArray(readPath(projected, path));
          const removals =
            key === '$pullAll'
              ? asArray(operand)
              : operand && typeof operand === 'object' && '$in' in operand
                ? asArray((operand as any).$in)
                : [operand];
          if (
            key === '$pull' &&
            operand &&
            typeof operand === 'object' &&
            !('$in' in operand)
          ) {
            // `$pull: { tags: { $regex: … } }` is a query, not a value. Nothing
            // uses it here and simulating a Mongo query would be a second
            // matcher to keep in step with the first.
            throw new SearchKeysReplayError(
              `searchKeysPlugin cannot replay a $pull query on "${path}".`,
            );
          }
          const removed = new Set(removals.map((entry) => String(entry)));
          writePath(
            projected,
            path,
            current.filter((entry) => !removed.has(String(entry))),
          );
          break;
        }
      }
    }
  }

  return projected;
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

  const watched = watchedPaths(options);
  /** Projection that loads exactly what {@link computeSearchKeys} reads. */
  const projection = watched.reduce<Record<string, 1>>(
    (fields, path) => ({ ...fields, [path]: 1 }),
    {},
  );
  const keysUpdate = (source: Record<string, any>) => {
    const computed = computeSearchKeys(source, options);
    return {
      [SEARCH_KEYS_FIELD]: computed.searchKeys,
      [SEARCH_KEYS_PII_FIELD]: computed.searchKeysPii,
    };
  };

  schema.pre('save', function (next) {
    const self = this as any;
    // Recompute only when something that feeds the arrays actually changed.
    // Otherwise every unrelated `save()` — and on a conversation that is every
    // inbound message — would rewrite two indexed arrays.
    const touched =
      self.isNew || watched.some((path: string) => self.isModified(path));
    if (touched) Object.assign(self, keysUpdate(self));
    next();
  });

  /**
   * Single-document updates: read the current values, replay the update over
   * them, and fold the result into the *same* write. No extra round-trip to the
   * database and no window in which the arrays disagree with the document.
   */
  const recomputeOne = async function (this: any) {
    const update = this.getUpdate();
    const upserting = this.getOptions?.()?.upsert === true;
    if (!analyseUpdate(update, watched).touched && !upserting) return;

    const current = await this.model
      .findOne(this.getFilter())
      .select(projection)
      .lean()
      .setOptions({ isPlatformQuery: this.getOptions?.()?.isPlatformQuery })
      .session(this.getOptions?.()?.session ?? null);

    // On an upsert that inserts there is no current document, and the values the
    // caller expressed as a filter become part of the new one.
    const base =
      current ?? (upserting ? filterEqualities(this.getFilter()) : {});
    const replayed = replayUpdate(
      projectWatched(base, watched),
      update,
      watched,
    );
    for (const [field, value] of Object.entries(keysUpdate(replayed))) {
      this.set(field, value);
    }
  };

  schema.pre('findOneAndUpdate', recomputeOne);
  schema.pre('updateOne', recomputeOne);

  /**
   * `updateMany` needs one array per matched document, which a single update
   * statement cannot express — so the affected documents are captured here and
   * re-keyed after the write succeeds. After, not before: if the caller's update
   * fails, the arrays must still describe the documents as they actually are.
   */
  const PENDING = Symbol('searchKeysPendingDocs');

  schema.pre('updateMany', async function (this: any) {
    const update = this.getUpdate();
    const analysis = analyseUpdate(update, watched);
    if (!analysis.touched) return;
    // Surface an unreplayable operator here rather than after the write, so the
    // caller's update is rejected instead of half-applied.
    replayUpdate({}, update, watched);

    const docs = await this.model
      .find(this.getFilter())
      .select(projection)
      .limit(MAX_RECOMPUTE_DOCS + 1)
      .lean()
      .setOptions({ isPlatformQuery: this.getOptions?.()?.isPlatformQuery })
      .session(this.getOptions?.()?.session ?? null);

    if (docs.length > MAX_RECOMPUTE_DOCS) {
      throw new SearchKeysReplayError(
        `updateMany on ${this.model.modelName} touches searchable fields on more than ` +
          `${MAX_RECOMPUTE_DOCS} documents; batch the update so the search index can be ` +
          `maintained with it.`,
      );
    }
    this[PENDING] = docs;
  });

  schema.post('updateMany', async function (this: any) {
    const docs = this[PENDING] as Array<Record<string, any>> | undefined;
    this[PENDING] = undefined;
    if (!docs?.length) return;

    const update = this.getUpdate();
    const session = this.getOptions?.()?.session ?? undefined;
    const ops = docs.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: keysUpdate(
            replayUpdate(projectWatched(doc, watched), update, watched),
          ),
        },
      },
    }));

    // Driver-level so it cannot re-enter this plugin's own `bulkWrite` hook. It
    // needs no tenant predicate: every `_id` came from the
    // `find(this.getFilter())` above, which `tenantFilterPlugin` had already
    // scoped, and each op writes the derived arrays back onto the very document
    // they were computed from.
    for (let index = 0; index < ops.length; index += REKEY_CHUNK_SIZE) {
      // @platform-query — reviewed, see above.
      await this.model.collection.bulkWrite(
        ops.slice(index, index + REKEY_CHUNK_SIZE),
        { ordered: false, ...(session ? { session } : {}) },
      );
    }
  });

  /**
   * `Model.bulkWrite` bypasses query middleware entirely, so the arrays are
   * folded into the ops themselves. Inserts and replacements carry the whole
   * document and need no read; updates are resolved with one batched read for
   * the whole call rather than one per op, because the importer sends a thousand
   * of them at a time.
   */
  schema.pre(
    'bulkWrite' as any,
    function (
      this: any,
      next: (error?: any) => void,
      ops: any[],
      bulkOptions?: Record<string, any>,
    ) {
      void (async () => {
        const pendingUpdates: Array<{
          filter: any;
          update: any;
          upsert?: boolean;
        }> = [];

        for (const op of ops ?? []) {
          if (op?.insertOne?.document) {
            Object.assign(
              op.insertOne.document,
              keysUpdate(op.insertOne.document),
            );
            continue;
          }
          if (op?.replaceOne?.replacement) {
            Object.assign(
              op.replaceOne.replacement,
              keysUpdate(op.replaceOne.replacement),
            );
            continue;
          }
          if (op?.updateMany?.update) {
            if (analyseUpdate(op.updateMany.update, watched).touched) {
              throw new SearchKeysReplayError(
                `bulkWrite cannot maintain searchKeys for an updateMany op on ` +
                  `${this.modelName}: each matched document needs its own array. ` +
                  `Issue it as Model.updateMany() instead.`,
              );
            }
            continue;
          }
          const write = op?.updateOne;
          if (!write?.update) continue;
          if (
            !analyseUpdate(write.update, watched).touched &&
            write.upsert !== true
          ) {
            continue;
          }
          pendingUpdates.push(write);
        }

        if (pendingUpdates.length === 0) return;

        const session = bulkOptions?.session;
        // A filter of the form `{ _id: <value> }` — which is every real caller,
        // the importer included — resolves in one read for the whole batch
        // instead of one per op.
        const directId = (write: { filter?: any }) =>
          write.filter?._id != null && typeof write.filter._id !== 'object'
            ? write.filter._id
            : null;

        const batchedIds = pendingUpdates
          .map(directId)
          .filter((id) => id !== null);
        const byId = new Map<string, Record<string, any>>();
        // `Model.bulkWrite` runs no middleware, so there is no scoped filter to
        // inherit: the ids are the caller's own `_id` targets, the only thing
        // derived from what is read is the `searchKeys` written back onto those
        // same documents, and nothing read is returned to a caller.
        if (batchedIds.length > 0) {
          // @platform-query — reviewed, see above.
          const found = await this.collection
            .find(
              { _id: { $in: batchedIds } },
              { projection, ...(session ? { session } : {}) },
            )
            .toArray();
          for (const doc of found) byId.set(String(doc._id), doc);
        }

        for (const write of pendingUpdates) {
          const id = directId(write);
          // Same reasoning as the batched read above: the caller's own bulkWrite
          // filter, and the only output is the derived array written back into
          // that same op's `$set`.
          // @platform-query — reviewed.
          const current =
            id !== null
              ? (byId.get(String(id)) ?? null)
              : await this.collection.findOne(write.filter, {
                  projection,
                  ...(session ? { session } : {}),
                });
          const base =
            current ??
            (write.upsert === true ? filterEqualities(write.filter) : {});
          const replayed = replayUpdate(
            projectWatched(base, watched),
            write.update,
            watched,
          );
          write.update.$set = {
            ...(write.update.$set ?? {}),
            ...keysUpdate(replayed),
          };
        }
      })().then(
        () => next(),
        (error) => next(error),
      );
    },
  );
}
