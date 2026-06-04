import { Logger } from '@nestjs/common';
import { Model } from 'mongoose';
import {
  DedupMatchingField,
  DedupPolicy,
  ImportErrorCode,
  ImportRowError,
  MappedRow,
} from './types';

/**
 * Configuration for the dedup engine — provided by each module's processor.
 */
export interface DedupConfig {
  /** Fields to match on (e.g. ['emails', 'phones'] for contacts). */
  matchingFields: DedupMatchingField[];
  /** How to handle a match: skip, overwrite, merge, create_new. */
  policy: DedupPolicy;
}

/**
 * Result of dedup lookup for a single row.
 */
export interface DedupMatch {
  /** The matched existing document, or null if no match. */
  existing: any | null;
  /** Whether this row was claimed by an earlier row in the same file. */
  claimedByEarlierRow: boolean;
}

/**
 * Generic dedup engine shared by all import modules.
 *
 * The engine does NOT know which entity it's deduplicating — it receives
 * a Mongoose model, the matching fields, and a value-extractor function
 * from the module processor.
 *
 * Design principles:
 *   - One $in query per dedup field per batch (NOT per row)
 *   - Within-file dedup via `claimedKeys` set
 *   - Module-specific field extraction is delegated to the processor
 */
export class ImportDedupEngine {
  private readonly logger = new Logger(ImportDedupEngine.name);

  /** Keys already claimed by inserts in THIS import run (within-file dedup). */
  private readonly claimedKeys = new Set<string>();

  /**
   * Perform batch dedup lookup for a set of mapped rows.
   *
   * @param model - The Mongoose model to query.
   * @param tenantId - The tenant to scope the query to.
   * @param batch - The mapped rows to dedup.
   * @param config - Dedup configuration (fields + policy).
   * @param extractValues - Module callback: given a MappedRow and a matching field name,
   *                        return the values to match against (e.g. emails, phone numbers).
   * @returns A Map from row number to DedupMatch.
   */
  async lookupBatch(
    model: Model<any>,
    tenantId: string,
    batch: MappedRow[],
    config: DedupConfig,
    extractValues: (row: MappedRow, field: DedupMatchingField) => string[],
  ): Promise<Map<number, DedupMatch>> {
    const results = new Map<number, DedupMatch>();

    if (config.matchingFields.length === 0) {
      // No dedup configured — every row is a fresh insert.
      for (const m of batch) {
        results.set(m.row, { existing: null, claimedByEarlierRow: false });
      }
      return results;
    }

    // Collect all values to query per matching field.
    const fieldValues = new Map<DedupMatchingField, string[]>();
    for (const field of config.matchingFields) {
      const allVals: string[] = [];
      for (const m of batch) {
        allVals.push(...extractValues(m, field));
      }
      fieldValues.set(field, [...new Set(allVals.filter(Boolean))]);
    }

    // Build the $or query — one clause per matching field with $in.
    const or: any[] = [];
    for (const [field, values] of fieldValues) {
      if (values.length > 0) {
        or.push({ [field]: { $in: values } });
      }
    }

    // Execute the batch lookup query.
    const existingDocs: any[] = [];
    if (or.length > 0) {
      const found = await model
        .find({
          tenantId,
          deletedAt: { $exists: false },
          $or: or,
        })
        .lean()
        .exec();
      existingDocs.push(...found);
    }

    // Index existing docs by each matching field's values for O(1) lookup.
    const lookupMaps = new Map<DedupMatchingField, Map<string, any>>();
    for (const field of config.matchingFields) {
      const lookup = new Map<string, any>();
      for (const doc of existingDocs) {
        const docValues = Array.isArray(doc[field])
          ? doc[field]
          : doc[field]
            ? [String(doc[field])]
            : [];
        for (const v of docValues) {
          // Normalize to lowercase for case-insensitive matching on string fields.
          const normalized =
            typeof v === 'string' ? v.toLowerCase() : String(v);
          if (!lookup.has(normalized)) lookup.set(normalized, doc);
        }
      }
      lookupMaps.set(field, lookup);
    }

    // Match each row against the lookup maps.
    for (const m of batch) {
      let match: any | null = null;

      for (const field of config.matchingFields) {
        const lookup = lookupMaps.get(field)!;
        const values = extractValues(m, field);
        for (const v of values) {
          const normalized =
            typeof v === 'string' ? v.toLowerCase() : String(v);
          const hit = lookup.get(normalized);
          if (hit) {
            match = hit;
            break;
          }
        }
        if (match) break;
      }

      if (match) {
        results.set(m.row, { existing: match, claimedByEarlierRow: false });
        continue;
      }

      // Within-file dedup: don't insert two rows sharing a dedup key.
      const keys = this.buildDedupKeys(m, config.matchingFields, extractValues);
      const clash = keys.find((k) => this.claimedKeys.has(k));
      if (clash) {
        results.set(m.row, { existing: null, claimedByEarlierRow: true });
        continue;
      }

      // No match and no clash — claim the keys for this row.
      keys.forEach((k) => this.claimedKeys.add(k));
      results.set(m.row, { existing: null, claimedByEarlierRow: false });
    }

    return results;
  }

  /**
   * Build dedup keys for within-file dedup (same format as the lookup keys).
   */
  private buildDedupKeys(
    row: MappedRow,
    fields: DedupMatchingField[],
    extractValues: (row: MappedRow, field: DedupMatchingField) => string[],
  ): string[] {
    const keys: string[] = [];
    for (const field of fields) {
      for (const v of extractValues(row, field)) {
        const normalized = typeof v === 'string' ? v.toLowerCase() : String(v);
        keys.push(`${field}:${normalized}`);
      }
    }
    return keys;
  }

  /**
   * Build an ImportRowError for a within-file duplicate.
   */
  buildDuplicateInFileError(
    row: MappedRow,
    clashValue?: string,
  ): ImportRowError {
    return {
      row: row.row,
      code: ImportErrorCode.DUPLICATE_IN_FILE,
      reason: 'Skipped: duplicate of an earlier row in the same file',
      value: clashValue,
    };
  }
}
