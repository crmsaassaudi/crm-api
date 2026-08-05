import {
  ConfigurableObject,
  StandardFieldDescriptor,
} from '../object-registry';

/**
 * How a layout constrains one field for one audience, and how those constraints
 * resolve when a caller belongs to several groups.
 *
 * Kept free of Nest and of Mongo on purpose: this is the decision that governs
 * what leaves the API, so it should be readable and testable without a container
 * or a database. `LayoutSettingsService` supplies the stored documents; every rule
 * about what they mean lives here.
 */

export const ACCESS_LEVELS = ['read_write', 'read_only', 'hidden'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const MASKING_STRATEGIES = ['none', 'mask_all', 'last_4'] as const;
export type MaskingStrategy = (typeof MASKING_STRATEGIES)[number];

/** One field's configuration as stored inside `layout_settings`. */
export interface StoredFieldConfig {
  key: string;
  isVisible?: boolean;
  isRequired?: boolean;
  accessLevel?: AccessLevel;
  masking?: MaskingStrategy;
  section?: string;
  sortOrder?: number;
  visibleAtStages?: string[];
}

/** `layout_settings.groupLayouts[groupId]` — one entry per configurable object. */
export type StoredLayout = Partial<
  Record<ConfigurableObject | string, StoredFieldConfig[]>
>;

export interface StoredLayoutSettings {
  groupLayouts?: Record<string, StoredLayout>;
  sectionConfigs?: unknown;
}

export const DEFAULT_LAYOUT_GROUP = 'default';

/**
 * The effective policy for one caller on one object, expressed in payload keys.
 *
 * Payload keys, not column keys, and not the keys as stored: callers of this type
 * are the response serialiser and the write validator, both of which see payload
 * properties and nothing else. Translating once, here, is what removes the class
 * of bug where a policy named a field the data never had.
 */
export interface ResolvedFieldPolicy {
  hidden: ReadonlySet<string>;
  readOnly: ReadonlySet<string>;
  masking: ReadonlyMap<string, MaskingStrategy>;
  required: ReadonlySet<string>;
}

export const EMPTY_FIELD_POLICY: ResolvedFieldPolicy = {
  hidden: new Set(),
  readOnly: new Set(),
  masking: new Map(),
  required: new Set(),
};

const MASKING_STRENGTH: Record<MaskingStrategy, number> = {
  none: 0,
  last_4: 1,
  mask_all: 2,
};

/**
 * Pick the layouts that apply to a caller.
 *
 * `default` is a fallback, never an addition: a caller with an explicit group
 * layout must not also inherit the default's grants, or narrowing a group's access
 * would be undone by whatever the default happens to allow. This mirrors
 * `resolveApplicableLayouts` in the web so the two cannot disagree about which
 * layouts are in play — the previous server-side code ignored groups entirely and
 * always read `default`.
 */
export const selectApplicableLayouts = (
  groupLayouts: Record<string, StoredLayout> | undefined,
  groupIds: readonly string[],
): StoredLayout[] => {
  if (!groupLayouts) return [];

  const explicit = groupIds
    .map((groupId) => groupLayouts[groupId])
    .filter((layout): layout is StoredLayout => Boolean(layout));

  if (explicit.length > 0) return explicit;

  const fallback = groupLayouts[DEFAULT_LAYOUT_GROUP];
  return fallback ? [fallback] : [];
};

export interface ResolveFieldPolicyInput {
  object: ConfigurableObject;
  layouts: readonly StoredLayout[];
  /**
   * Translates a stored key — which may be a payload key, a column key or a
   * pre-split legacy alias — to its field. Supplied by `ObjectRegistryService`.
   */
  resolveField: (key: string) => StandardFieldDescriptor | undefined;
  /** Every payload property a policy on a field must cover (field + mirrors). */
  payloadKeysOf: (field: StandardFieldDescriptor) => string[];
}

/**
 * Collapse every applicable layout into one policy.
 *
 * Conflicts resolve toward less exposure, in all three dimensions:
 *   - hidden wins over visible,
 *   - read_only wins over read_write,
 *   - the stronger masking wins.
 *
 * A caller in two groups must not gain access because one of their groups is more
 * permissive; that is the shape of privilege escalation by group membership, and
 * "any group hides it" is the only merge rule that is safe to state in one line.
 *
 * `isRequired` merges as a union too, but for a different reason: it is a data
 * rule rather than a permission, and the form the caller sees is generated from
 * the same layouts, so union keeps the client's form and the server's validation
 * describing the same contract.
 *
 * Read-only and audit fields never become required. That is not a preference — a
 * required check on a field the client cannot set is a 422 with no remedy, which
 * is precisely how marking Ticket "Type" required made every ticket create fail.
 */
export const resolveFieldPolicy = ({
  object,
  layouts,
  resolveField,
  payloadKeysOf,
}: ResolveFieldPolicyInput): ResolvedFieldPolicy => {
  const hidden = new Set<string>();
  const readOnly = new Set<string>();
  const masking = new Map<string, MaskingStrategy>();
  const required = new Set<string>();

  for (const layout of layouts) {
    // Only this object's entries. A layout document holds one array per object,
    // and reading all of them would let a Contact policy govern a Ticket field
    // that happens to share a key — `ownerId`, `tags` and `statusId` are on every
    // object, so that mistake would be both easy and invisible.
    const configs = layout[object];
    if (Array.isArray(configs)) {
      for (const config of configs) {
        const field = resolveField(config.key);
        // An entry naming a field the object does not have is inert. Dropping it
        // silently is right: it is what a layout looks like after a field is
        // retired, and failing the whole response over it would take the module
        // down for a stale settings row.
        if (!field) continue;

        const keys = payloadKeysOf(field);
        const isHidden =
          config.accessLevel === 'hidden' || config.isVisible === false;

        for (const key of keys) {
          if (isHidden) hidden.add(key);
          if (
            isHidden ||
            config.accessLevel === 'read_only' ||
            field.readOnly
          ) {
            readOnly.add(key);
          }
          if (config.masking && config.masking !== 'none') {
            const current = masking.get(key);
            if (
              !current ||
              MASKING_STRENGTH[config.masking] > MASKING_STRENGTH[current]
            ) {
              masking.set(key, config.masking);
            }
          }
        }

        if (config.isRequired && !field.readOnly && !field.audit && !isHidden) {
          required.add(field.key);
        }
      }
    }
  }

  return { hidden, readOnly, masking, required };
};

/** Apply a masking strategy to one already-serialised string. */
export const applyMask = (value: string, strategy: MaskingStrategy): string => {
  if (!value || value.includes('***')) return value;
  if (strategy === 'mask_all') return '********';
  if (strategy === 'last_4') {
    return value.length <= 4 ? '********' : `****${value.slice(-4)}`;
  }
  return value;
};
