/**
 * AuditDiffEngine — Computes field-level deltas between two entity snapshots.
 *
 * Design decisions:
 * - Stateless / pure static utility — no DI, no side effects
 * - Runs at AuditLogListener (async, outside request thread) — [PATCH P2]
 * - Truncates long strings to cap each changes[] element at ~500 bytes — [PATCH R3]
 * - Normalizes primitive arrays (sort before compare) to avoid false positives
 * - Supports custom field label injection for schema drift prevention — [PATCH P3]
 */

const IGNORED_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  '__v',
  '_id',
  'id',
  'tenantId',
  'createdBy',
  'createdById',
  'updatedBy',
  'updatedById',
]);

export class AuditDiffEngine {
  /**
   * Converts a Mongoose document (or any object) to a plain JSON-safe object.
   * Strips undefined values and converts Date → ISO string for stable comparison.
   */
  static toPlain(doc: any): Record<string, any> {
    if (!doc) return {};
    const raw = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return JSON.parse(JSON.stringify(raw)); // strip undefined, Date → string
  }

  /**
   * Computes the field-level delta between two snapshots.
   *
   * @param oldDoc - Plain object snapshot (before update)
   * @param newDoc - Plain object snapshot (after update)
   * @param customFieldLabels - Map { field_key → display_label } at time of change.
   *   Example: { custom_field_101: 'Mã số thuế' }
   *   [PATCH P3] Resolves Custom Field Schema Drift.
   *   [PATCH R2] Resolved by AuditLogListener via CustomFieldsCacheService.
   * @returns Array of change records, empty if no meaningful changes detected.
   */
  static computeDelta(
    oldDoc: any,
    newDoc: any,
    customFieldLabels?: Record<string, string>,
  ): Array<{ f: string; l?: string; o: any; n: any }> {
    const o = this.toPlain(oldDoc);
    const n = this.toPlain(newDoc);
    const allKeys = new Set([...Object.keys(o), ...Object.keys(n)]);
    const changes: Array<{ f: string; l?: string; o: any; n: any }> = [];

    for (const key of allKeys) {
      if (IGNORED_FIELDS.has(key)) continue;

      const oldVal = o[key];
      const newVal = n[key];

      // Sort arrays of primitives before comparing to avoid false-positive diffs
      // caused by order differences (e.g. tags: ['a','b'] vs ['b','a'])
      const normalize = (v: any) =>
        Array.isArray(v) && v.every((x) => typeof x !== 'object')
          ? JSON.stringify([...v].sort())
          : JSON.stringify(v);

      if (normalize(oldVal) !== normalize(newVal)) {
        const change: { f: string; l?: string; o: any; n: any } = {
          f: key,
          // [PATCH R3] Truncate long string values to prevent storage bloat
          o: this.truncate(oldVal),
          n: this.truncate(newVal),
        };

        // [PATCH P3] Attach label snapshot if available
        const label = customFieldLabels?.[key];
        if (label) {
          change.l = label;
        }

        changes.push(change);
      }
    }

    return changes;
  }

  /**
   * [PATCH R3] Truncates string values exceeding MAX_STRING_LENGTH characters.
   * For long text fields (descriptions, notes), stores a summary instead of
   * the full content. Keeps each changes[] element under ~500 bytes.
   */
  private static readonly MAX_STRING_LENGTH = 256;

  static truncate(value: any): any {
    if (typeof value !== 'string') return value;
    if (value.length <= this.MAX_STRING_LENGTH) return value;
    return `[Text Modified: ${value.length} chars] ${value.slice(0, 80)}...`;
  }
}
