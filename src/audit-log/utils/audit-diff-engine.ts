/**
 * AuditDiffEngine — Computes field-level deltas between two entity snapshots.
 *
 * Design decisions:
 * - Stateless / pure static utility — no DI, no side effects
 * - Runs at AuditLogListener (async, outside request thread)
 * - Uses WHITELIST approach: only explicitly listed fields are tracked
 *   → prevents virtual getters (owner, createdBy) and internal fields (version, __v)
 *   from leaking full user objects into audit storage
 * - Truncates long strings to cap each changes[] element at ~500 bytes
 * - Normalizes primitive arrays (sort before compare) to avoid false positives
 * - Supports custom field label injection for schema drift prevention
 */

/**
 * Whitelist of fields tracked per entity type.
 * Fields NOT listed here are silently excluded from audit diffs.
 *
 * Why whitelist instead of blacklist?
 * - Virtual getters (owner, createdBy, updatedBy) serialize full User objects
 *   via toJSON({ virtuals: true }) — blacklist is error-prone and leaks PII
 * - New internal fields (e.g. scoring, shadow) won't pollute audit by default
 * - Explicit list makes audit scope auditable and reviewable
 */
const TRACKED_FIELDS: Record<string, Set<string>> = {
  CONTACT: new Set([
    'firstName',
    'lastName',
    'emails',
    'phones',
    'companyName',
    'title',
    'role',
    'address',
    'birthday',
    'lifecycleStageId',
    'statusId',
    'sourceId',
    'accountId',
    'ownerId',
    'score',
    'emailOptIn',
    'smsOptIn',
    'doNotCall',
    'tags',
    'isVIP',
    'customFields',
    '_deleted',
  ]),
  DEAL: new Set([
    'title',
    'name',
    'value',
    'currency',
    'closeDate',
    'stageId',
    'pipelineId',
    'contactId',
    'accountId',
    'ownerId',
    'probability',
    'priority',
    'tags',
    'customFields',
  ]),
  TICKET: new Set([
    'subject',
    'description',
    'priority',
    'statusId',
    'categoryId',
    'contactId',
    'accountId',
    'assigneeId',
    'tags',
    'dueDate',
    'customFields',
  ]),
};

/**
 * Fallback: fields that should NEVER be tracked regardless of entity type.
 * Used when entity type is unknown (safety net).
 */
const ALWAYS_IGNORED = new Set([
  '_id',
  'id',
  '__v',
  'tenantId',
  'createdAt',
  'updatedAt',
  'createdBy',
  'createdById',
  'updatedBy',
  'updatedById',
  'version',
  'owner',
  'deletedAt',
  'isShadow',
  'stageHistory',
  'omniIdentities',
  'lastActivityAt',
  'isConverted',
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
   *   Resolved by AuditLogListener via CustomFieldsCacheService.
   * @param entityType - Entity type for whitelist lookup (CONTACT, DEAL, TICKET)
   * @returns Array of change records, empty if no meaningful changes detected.
   */
  static computeDelta(
    oldDoc: any,
    newDoc: any,
    customFieldLabels?: Record<string, string>,
    entityType?: string,
  ): Array<{ f: string; l?: string; o: any; n: any }> {
    const o = this.toPlain(oldDoc);
    const n = this.toPlain(newDoc);
    const allKeys = new Set([...Object.keys(o), ...Object.keys(n)]);
    const changes: Array<{ f: string; l?: string; o: any; n: any }> = [];

    // Resolve the whitelist for this entity type
    const tracked = entityType ? TRACKED_FIELDS[entityType] : undefined;

    for (const key of allKeys) {
      // Always skip internal/virtual fields
      if (ALWAYS_IGNORED.has(key)) continue;

      // If whitelist exists for this entity, skip fields not in it
      // Exception: keys starting with 'custom_' are always allowed (custom fields)
      if (tracked && !tracked.has(key) && !key.startsWith('custom_')) continue;

      const oldVal = o[key];
      const newVal = n[key];

      // For ref fields (ownerId, accountId, etc.), extract just the ID string
      // to prevent storing populated objects
      const sanitized = (v: any) => {
        if (v && typeof v === 'object' && !Array.isArray(v) && v._id) {
          return String(v._id);
        }
        return v;
      };

      const sOld = sanitized(oldVal);
      const sNew = sanitized(newVal);

      // Sort arrays of primitives before comparing to avoid false-positive diffs
      // caused by order differences (e.g. tags: ['a','b'] vs ['b','a'])
      const normalize = (v: any) =>
        Array.isArray(v) && v.every((x) => typeof x !== 'object')
          ? JSON.stringify([...v].sort())
          : JSON.stringify(v);

      if (normalize(sOld) !== normalize(sNew)) {
        const change: { f: string; l?: string; o: any; n: any } = {
          f: key,
          o: this.truncate(sOld),
          n: this.truncate(sNew),
        };

        // Attach label snapshot if available
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
   * Truncates string values exceeding MAX_STRING_LENGTH characters.
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
