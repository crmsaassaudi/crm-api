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
  existing: any;
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
      for (const m of batch) {
        results.set(m.row, { existing: null, claimedByEarlierRow: false });
      }
      return results;
    }

    const fieldValues = this.collectFieldValues(batch, config, extractValues);
    const existingDocs = await this.fetchExistingDocs(
      model,
      tenantId,
      fieldValues,
    );
    const lookupMaps = this.buildLookupMaps(
      config.matchingFields,
      existingDocs,
    );
    this.matchRows(batch, config, extractValues, lookupMaps, results);

    return results;
  }

  /** Collect all candidate dedup values per field across the batch. */
  private collectFieldValues(
    batch: MappedRow[],
    config: DedupConfig,
    extractValues: (row: MappedRow, field: DedupMatchingField) => string[],
  ): Map<DedupMatchingField, string[]> {
    const fieldValues = new Map<DedupMatchingField, string[]>();
    for (const field of config.matchingFields) {
      const allVals: string[] = [];
      for (const m of batch) {
        allVals.push(...extractValues(m, field));
      }
      fieldValues.set(field, [...new Set(allVals.filter(Boolean))]);
    }
    return fieldValues;
  }

  /** Run the batch $or query and return matching documents. */
  private async fetchExistingDocs(
    model: Model<any>,
    tenantId: string,
    fieldValues: Map<DedupMatchingField, string[]>,
  ): Promise<any[]> {
    const or: any[] = [];
    for (const [field, values] of fieldValues) {
      if (values.length > 0) {
        or.push({ [field]: { $in: values } });
      }
    }
    if (or.length === 0) return [];
    return model
      .find({ tenantId, deletedAt: { $exists: false }, $or: or })
      .lean()
      .exec();
  }

  /** Build a per-field normalized-value → document lookup map. */
  private buildLookupMaps(
    matchingFields: DedupMatchingField[],
    existingDocs: any[],
  ): Map<DedupMatchingField, Map<string, any>> {
    const lookupMaps = new Map<DedupMatchingField, Map<string, any>>();
    for (const field of matchingFields) {
      const lookup = new Map<string, any>();
      for (const doc of existingDocs) {
        const docValues: string[] = Array.isArray(doc[field])
          ? doc[field]
          : doc[field] != null
            ? [String(doc[field])]
            : [];
        for (const v of docValues) {
          const normalized =
            typeof v === 'string' ? v.toLowerCase() : String(v);
          if (!lookup.has(normalized)) lookup.set(normalized, doc);
        }
      }
      lookupMaps.set(field, lookup);
    }
    return lookupMaps;
  }

  /** Match each row against the lookup maps; record results and claimed keys. */
  private matchRows(
    batch: MappedRow[],
    config: DedupConfig,
    extractValues: (row: MappedRow, field: DedupMatchingField) => string[],
    lookupMaps: Map<DedupMatchingField, Map<string, any>>,
    results: Map<number, DedupMatch>,
  ): void {
    for (const m of batch) {
      let match: any = null;
      outer: for (const field of config.matchingFields) {
        const lookup = lookupMaps.get(field)!;
        for (const v of extractValues(m, field)) {
          const normalized =
            typeof v === 'string' ? v.toLowerCase() : String(v);
          const hit = lookup.get(normalized);
          if (hit) {
            match = hit;
            break outer;
          }
        }
      }

      if (match) {
        results.set(m.row, { existing: match, claimedByEarlierRow: false });
        continue;
      }

      const keys = this.buildDedupKeys(m, config.matchingFields, extractValues);
      const clash = keys.find((k) => this.claimedKeys.has(k));
      if (clash) {
        results.set(m.row, { existing: null, claimedByEarlierRow: true });
        continue;
      }

      keys.forEach((k) => this.claimedKeys.add(k));
      results.set(m.row, { existing: null, claimedByEarlierRow: false });
    }
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
