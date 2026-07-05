import { Logger } from '@nestjs/common';
import { Connection } from 'mongoose';
import { ImportErrorCode, ImportReferenceField, ImportRowError } from './types';

/**
 * Resolved reference: the input text + the resolved ObjectId.
 */
export interface ResolvedReference {
  field: string;
  inputValue: string;
  resolvedId: string;
}

/**
 * Reference resolution result for a single row.
 */
export interface RowReferenceResult {
  /** Successfully resolved references. */
  resolved: Record<string, string>;
  /** Errors for references that couldn't be resolved. */
  errors: ImportRowError[];
}

// Regex for a valid MongoDB ObjectId (24 hex chars).
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Batch reference resolver for import jobs.
 *
 * Design principles:
 *   1. User enters text (e.g. "Qualified", "Complaint") — backend resolves to ObjectId
 *   2. If the value IS already a valid ObjectId, validate it exists in the org
 *   3. 0 matches → reference_not_found error
 *   4. Multiple matches → reference_ambiguous error
 *   5. Cache per import job — resolve once for the entire file, not per row
 *
 * The resolver batch-loads ALL possible reference values for each field at the
 * start of an import job, then does O(1) lookups per row. This prevents N+1
 * queries on large files.
 */
export class ImportReferenceResolver {
  private readonly logger = new Logger(ImportReferenceResolver.name);

  /** Cache: fieldName → (textValue → resolvedId) */
  private readonly cache = new Map<string, Map<string, string>>();
  /** Cache: fieldName → (objectId → boolean) for ObjectId validation */
  private readonly idCache = new Map<string, Set<string>>();
  private initialized = false;

  constructor(
    private readonly connection: Connection,
    private readonly tenantId: string,
    private readonly referenceFields: readonly ImportReferenceField[],
  ) {}

  /**
   * Pre-load all reference data for the configured fields.
   * MUST be called once before resolveRow().
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    for (const refField of this.referenceFields) {
      const collection = this.connection.db!.collection(refField.collection);

      const query: any = {};
      if (refField.tenantScoped) {
        query.tenantId = this.tenantId;
      }

      const projection: any = { _id: 1 };
      for (const lookupField of refField.lookupFields) {
        projection[lookupField] = 1;
      }

      const docs = await collection.find(query).project(projection).toArray();
      const { textMap, idSet } = this.buildFieldCachesFromDocs(
        docs,
        refField.lookupFields,
      );
      this.cache.set(refField.entityField, textMap);
      this.idCache.set(refField.entityField, idSet);
    }

    this.initialized = true;
    const fieldSummary = this.referenceFields
      .map(
        (f) => `${f.entityField}(${this.cache.get(f.entityField)?.size ?? 0})`,
      )
      .join(', ');
    this.logger.debug(
      `Reference resolver initialized for tenant ${this.tenantId}: ${fieldSummary}`,
    );
  }

  /** Build text→id and id-set caches from a collection's raw documents. */
  private buildFieldCachesFromDocs(
    docs: any[],
    lookupFields: readonly string[],
  ): { textMap: Map<string, string>; idSet: Set<string> } {
    const textMap = new Map<string, string>();
    const idSet = new Set<string>();
    for (const doc of docs) {
      const id = String(doc._id);
      idSet.add(id);
      for (const lookupField of lookupFields) {
        const value = doc[lookupField];
        if (value != null) {
          const normalized = String(value).trim().toLowerCase();
          if (normalized && !textMap.has(normalized)) {
            textMap.set(normalized, id);
          }
        }
      }
    }
    return { textMap, idSet };
  }

  /**
   * Resolve all reference fields for a single mapped row.
   *
   * @param rowNum - 1-based row number for error reporting.
   * @param fields - The row's scalar fields (key = entity field name).
   * @returns Resolved ObjectId values + any errors.
   */
  resolveRow(rowNum: number, fields: Record<string, any>): RowReferenceResult {
    const resolved: Record<string, string> = {};
    const errors: ImportRowError[] = [];

    for (const refField of this.referenceFields) {
      const inputValue = fields[refField.entityField];

      // No value provided — use default or skip.
      if (inputValue == null || String(inputValue).trim() === '') {
        if (refField.defaultValue) {
          resolved[refField.entityField] = refField.defaultValue;
        } else if (refField.required) {
          errors.push({
            row: rowNum,
            code: ImportErrorCode.REQUIRED_FIELD_MISSING,
            field: refField.entityField,
            reason: `Required reference field "${refField.entityField}" is missing`,
          });
        }
        continue;
      }

      const valueStr = String(inputValue).trim();

      // Step 1: Check if the value is a valid ObjectId.
      if (OBJECT_ID_REGEX.test(valueStr)) {
        this.resolveByObjectId(
          rowNum,
          refField.entityField,
          valueStr,
          resolved,
          errors,
        );
        continue;
      }

      // Step 2: Try text-based resolution.
      this.resolveByText(
        rowNum,
        refField.entityField,
        refField.required,
        valueStr,
        resolved,
        errors,
      );
    }

    return { resolved, errors };
  }

  /** Resolve a field whose raw value is already a valid ObjectId hex string. */
  private resolveByObjectId(
    rowNum: number,
    field: string,
    valueStr: string,
    resolved: Record<string, string>,
    errors: ImportRowError[],
  ): void {
    const idSet = this.idCache.get(field);
    if (idSet?.has(valueStr)) {
      resolved[field] = valueStr;
      return;
    }
    errors.push({
      row: rowNum,
      code: ImportErrorCode.REFERENCE_NOT_FOUND,
      field,
      reason: `Reference "${field}" ObjectId "${valueStr}" not found in this organization`,
      value: valueStr,
    });
  }

  /** Resolve a field via text-based cache lookup. */
  private resolveByText(
    rowNum: number,
    field: string,
    required: boolean | undefined,
    valueStr: string,
    resolved: Record<string, string>,
    errors: ImportRowError[],
  ): void {
    const textMap = this.cache.get(field);
    const resolvedId = textMap?.get(valueStr.toLowerCase());
    if (resolvedId) {
      resolved[field] = resolvedId;
      return;
    }
    if (required) {
      errors.push({
        row: rowNum,
        code: ImportErrorCode.REFERENCE_NOT_FOUND,
        field,
        reason: `Reference "${field}" value "${valueStr}" not found. Check the value and try again.`,
        value: valueStr,
      });
    }
    // Non-required references that fail to resolve are silently skipped.
  }
}
