import { FieldType, isMaskableFieldType } from '../custom-fields/field-type';

/**
 * The canonical description of every standard field on every configurable object.
 *
 * Why this file exists
 *
 * This catalog used to live in the browser bundle (`crm-web/src/features/
 * custom-fields/constants.ts`) while the things that consume it — masking,
 * required-field validation, field-level security — run on the server. Nothing
 * connected the two, so the two drifted, and every consequence of the drift was
 * silent:
 *
 *   - The browser offered a field named `amount` on Deal. The payload key is
 *     `value`. A masking rule on "Amount" therefore matched no property and the
 *     settings screen reported it as active.
 *   - The browser offered `type` on Ticket. `TicketsService.validateRequiredFields`
 *     reads `data[field.key]`, and the payload key is `typeId`. Marking Type
 *     required made `data['type']` permanently absent, so *every* ticket create
 *     returned 422 with no way to fix it from the UI.
 *   - `DEFAULT_LIST_VIEWS` seeded a `fullName` column that the field catalog did
 *     not contain, so once removed it could not be added back.
 *
 * The two namespaces, named
 *
 * The drift was not one mistake repeated; it was two legitimate identities for a
 * field that had never been distinguished:
 *
 *   `key`     the property name in the API payload. This is the field's identity
 *             for anything that reads or writes a value: masking, required,
 *             field-level security, validation rules, custom-field filters.
 *             `ownerId`, `statusId`, `value`, `numberOfEmployees`.
 *
 *   `column`  the identity of the *rendered column*. A list view shows the owner's
 *             name and avatar from the populated `owner` object, not the raw
 *             `ownerId`, so the column is legitimately called `owner`. Defaults to
 *             `key` when a field renders itself.
 *
 * Conflating them is what produced every symptom above. Declaring both, in one
 * place, with a drift test on each side (`object-registry.drift.spec.ts` checks
 * `key` against the Mongoose schema; the web's `columnRegistry.contract.test.ts`
 * checks `column` against the column registry) is what keeps them from drifting
 * again.
 *
 * Rules
 *
 * `key` MUST equal a real payload property. Adding a field here without adding it
 * to the schema fails the drift spec — deliberately, because that failure is the
 * only thing that would have caught the four bugs above.
 */

/** Objects that expose an Object Manager configuration surface. */
export const CONFIGURABLE_OBJECTS = [
  'Contact',
  'Account',
  'Deal',
  'Ticket',
  'Task',
] as const;

export type ConfigurableObject = (typeof CONFIGURABLE_OBJECTS)[number];

const CONFIGURABLE_OBJECT_SET: ReadonlySet<string> = new Set(
  CONFIGURABLE_OBJECTS,
);

export const isConfigurableObject = (
  value: unknown,
): value is ConfigurableObject =>
  typeof value === 'string' && CONFIGURABLE_OBJECT_SET.has(value);

/**
 * Grouping used by the settings UI to lay fields out in sections. Purely
 * presentational — nothing branches on it.
 */
export type FieldCategory =
  | 'basic'
  | 'contactInfo'
  | 'classification'
  | 'relationship'
  | 'assignment'
  | 'status'
  | 'financial'
  | 'scheduling'
  | 'resolution'
  | 'address'
  | 'personal'
  | 'metrics'
  | 'channel'
  | 'audit';

export interface StandardFieldDescriptor {
  /** Payload property name. The field's identity for every value-level rule. */
  readonly key: string;
  /**
   * Rendered-column identity. Omitted when it equals `key` — which is the common
   * case and the one worth keeping quiet.
   */
  readonly column?: string;
  /** i18n token, resolved by the client. Never a human string. */
  readonly labelToken: string;
  readonly type: FieldType;
  readonly category: FieldCategory;
  /**
   * The server owns this value; a client-supplied one is ignored.
   *
   * Read-only fields cannot be marked required (there is nothing for the user to
   * fill in) and cannot be made writable by a layout. `validateRequiredFields`
   * skips them rather than producing an unsatisfiable 422.
   */
  readonly readOnly?: boolean;
  /** Audit metadata. Read-only, and hidden from layout configuration entirely. */
  readonly audit?: boolean;
  /**
   * True when the value does not live under `key` on the document — `Contact.name`
   * is concatenated in the mapper. Excluded from the schema drift check, which is
   * why it must be stated rather than inferred.
   */
  readonly derived?: boolean;
  /**
   * Set when a field must never be offered as maskable even though its type is
   * string-shaped — a primary label that masks makes every list unreadable
   * without protecting anything the record's own permission does not already
   * cover.
   */
  readonly maskable?: false;
  /**
   * Keys this field was stored under before payload key and column key were
   * separated.
   *
   * Distinct from `column`, and the distinction is load-bearing: `column` is what
   * a list view legitimately calls the field *today*, while these are names that
   * only ever existed because the browser catalog invented them — `amount` for
   * `value`, `subject` for a Task's `title`, `assignee` for its `ownerId`. They
   * appear in `layout_settings` and `validation_rules` documents already in
   * production.
   *
   * Kept so `resolveFieldKey` can read an un-migrated document, which is what
   * makes the migration additive instead of a cutover. Never written, never
   * offered in the UI.
   */
  readonly legacyAliases?: readonly string[];
  // `mirroredKeys` used to live here: a way to say "this policy must also cover
  // that other property, because it holds the same value". It had exactly one
  // user, `Deal.name`, a stored duplicate of `Deal.title` that masking would
  // otherwise have redacted in one property and handed back in the other.
  //
  // Deleting the duplicate column deleted the reason for the mechanism. Keeping
  // a general facility with no users is how the next duplicate gets waved
  // through — the answer to "two properties, one value" is one property.
}

const AUDIT_FIELDS: readonly StandardFieldDescriptor[] = [
  {
    key: 'createdAt',
    labelToken: 'createdAt',
    type: 'DATETIME',
    category: 'audit',
    readOnly: true,
    audit: true,
  },
  {
    key: 'updatedAt',
    labelToken: 'updatedAt',
    type: 'DATETIME',
    category: 'audit',
    readOnly: true,
    audit: true,
  },
  {
    key: 'createdById',
    column: 'createdBy',
    labelToken: 'createdBy',
    type: 'USER_REFERENCE',
    category: 'audit',
    readOnly: true,
    audit: true,
  },
  {
    key: 'updatedById',
    column: 'updatedBy',
    labelToken: 'updatedBy',
    type: 'USER_REFERENCE',
    category: 'audit',
    readOnly: true,
    audit: true,
  },
] as const;

const CONTACT_FIELDS: readonly StandardFieldDescriptor[] = [
  {
    key: 'name',
    column: 'fullName',
    labelToken: 'fullName',
    type: 'TEXT',
    category: 'basic',
    readOnly: true,
    // Concatenated from firstName + lastName by ContactMapper. Listed because
    // DEFAULT_LIST_VIEWS ships a `fullName` column and a column the catalog does
    // not know about cannot be re-added once removed.
    derived: true,
    maskable: false,
  },
  {
    key: 'firstName',
    labelToken: 'firstName',
    type: 'TEXT',
    category: 'basic',
  },
  { key: 'lastName', labelToken: 'lastName', type: 'TEXT', category: 'basic' },
  {
    key: 'emails',
    labelToken: 'emails',
    type: 'EMAIL',
    category: 'contactInfo',
  },
  {
    key: 'phones',
    labelToken: 'phones',
    type: 'PHONE',
    category: 'contactInfo',
  },
  {
    key: 'companyName',
    labelToken: 'companyName',
    type: 'TEXT',
    category: 'basic',
  },
  { key: 'title', labelToken: 'jobTitle', type: 'TEXT', category: 'basic' },
  {
    key: 'accountId',
    column: 'account',
    labelToken: 'account',
    type: 'RELATION',
    category: 'relationship',
  },
  {
    key: 'ownerId',
    column: 'owner',
    labelToken: 'owner',
    type: 'USER_REFERENCE',
    category: 'assignment',
  },
  {
    key: 'lifecycleStageId',
    column: 'lifecycleStage',
    labelToken: 'lifecycleStage',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'statusId',
    column: 'status',
    labelToken: 'status',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'sourceId',
    column: 'source',
    labelToken: 'source',
    type: 'SINGLE_SELECT',
    category: 'classification',
  },
  { key: 'role', labelToken: 'role', type: 'TEXT', category: 'relationship' },
  {
    key: 'address',
    labelToken: 'address',
    type: 'TEXTAREA',
    category: 'address',
  },
  { key: 'city', labelToken: 'city', type: 'TEXT', category: 'address' },
  {
    key: 'country',
    labelToken: 'country',
    type: 'SINGLE_SELECT',
    category: 'address',
  },
  {
    key: 'birthday',
    labelToken: 'birthday',
    type: 'DATE',
    category: 'personal',
  },
  {
    key: 'externalId',
    labelToken: 'externalId',
    type: 'TEXT',
    category: 'classification',
  },
  {
    key: 'externalSource',
    labelToken: 'externalSource',
    type: 'TEXT',
    category: 'classification',
  },
  {
    key: 'score',
    labelToken: 'score',
    type: 'SCORE',
    category: 'metrics',
    readOnly: true,
  },
  // Customer value — derived from won deals, never client-writable.
  {
    key: 'totalRevenue',
    labelToken: 'totalRevenue',
    type: 'CURRENCY',
    category: 'metrics',
    readOnly: true,
  },
  {
    key: 'dealsCount',
    labelToken: 'dealsCount',
    type: 'NUMBER',
    category: 'metrics',
    readOnly: true,
  },
  {
    key: 'wonDealsCount',
    labelToken: 'wonDealsCount',
    type: 'NUMBER',
    category: 'metrics',
    readOnly: true,
  },
  {
    key: 'lastPurchaseAt',
    labelToken: 'lastPurchaseAt',
    type: 'DATETIME',
    category: 'metrics',
    readOnly: true,
  },
  {
    key: 'tags',
    labelToken: 'tags',
    type: 'MULTI_SELECT',
    category: 'classification',
  },
  {
    key: 'isVIP',
    labelToken: 'isVip',
    type: 'BOOLEAN',
    category: 'classification',
  },
  {
    key: 'emailOptIn',
    labelToken: 'emailOptIn',
    type: 'BOOLEAN',
    category: 'contactInfo',
  },
  {
    key: 'smsOptIn',
    labelToken: 'smsOptIn',
    type: 'BOOLEAN',
    category: 'contactInfo',
  },
  {
    key: 'whatsappOptIn',
    labelToken: 'whatsappOptIn',
    type: 'BOOLEAN',
    category: 'contactInfo',
  },
  {
    key: 'doNotCall',
    labelToken: 'doNotCall',
    type: 'BOOLEAN',
    category: 'contactInfo',
  },
  {
    key: 'lastActivityAt',
    labelToken: 'lastActivityAt',
    type: 'DATETIME',
    category: 'metrics',
    readOnly: true,
  },
  ...AUDIT_FIELDS,
] as const;

const ACCOUNT_FIELDS: readonly StandardFieldDescriptor[] = [
  {
    key: 'name',
    labelToken: 'accountName',
    type: 'TEXT',
    category: 'basic',
    maskable: false,
  },
  { key: 'website', labelToken: 'website', type: 'URL', category: 'basic' },
  {
    key: 'industry',
    labelToken: 'industry',
    type: 'SINGLE_SELECT',
    category: 'classification',
  },
  {
    key: 'typeId',
    column: 'accountType',
    labelToken: 'accountType',
    type: 'SINGLE_SELECT',
    category: 'classification',
  },
  {
    key: 'emails',
    labelToken: 'emails',
    type: 'EMAIL',
    category: 'contactInfo',
  },
  {
    key: 'phones',
    labelToken: 'phones',
    type: 'PHONE',
    category: 'contactInfo',
  },
  { key: 'taxId', labelToken: 'taxId', type: 'TEXT', category: 'financial' },
  {
    key: 'annualRevenue',
    labelToken: 'annualRevenue',
    type: 'CURRENCY',
    category: 'financial',
  },
  {
    // The web catalog called this `employees`; the payload key has always been
    // `numberOfEmployees`. The column keeps the short name it renders under.
    key: 'numberOfEmployees',
    column: 'employees',
    labelToken: 'employees',
    type: 'NUMBER',
    category: 'basic',
  },
  {
    key: 'billingAddress',
    labelToken: 'billingAddress',
    type: 'TEXTAREA',
    category: 'address',
  },
  {
    key: 'shippingAddress',
    labelToken: 'shippingAddress',
    type: 'TEXTAREA',
    category: 'address',
  },
  {
    key: 'ownerId',
    column: 'owner',
    labelToken: 'owner',
    type: 'USER_REFERENCE',
    category: 'assignment',
  },
  {
    key: 'statusId',
    column: 'status',
    labelToken: 'status',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'tags',
    labelToken: 'tags',
    type: 'MULTI_SELECT',
    category: 'classification',
  },
  ...AUDIT_FIELDS,
] as const;

const DEAL_FIELDS: readonly StandardFieldDescriptor[] = [
  {
    key: 'title',
    labelToken: 'dealName',
    type: 'TEXT',
    category: 'basic',
    maskable: false,
    // The old catalog exposed this field as `name`, so a saved view or a filter
    // written against that key still has to resolve. The stored duplicate it
    // used to mirror is gone — one required, indexed column held the same
    // string as `title`, kept in step by two hand-written assignments — so this
    // is now an alias only, with nothing to mirror onto.
    legacyAliases: ['name'],
  },
  {
    // The web catalog called this `amount`. `value` is the payload key, which is
    // why masking configured on "Amount" never fired.
    key: 'value',
    labelToken: 'amount',
    type: 'CURRENCY',
    category: 'financial',
    legacyAliases: ['amount'],
  },
  {
    key: 'currency',
    labelToken: 'currency',
    type: 'SINGLE_SELECT',
    category: 'financial',
  },
  {
    key: 'closeDate',
    labelToken: 'closeDate',
    type: 'DATE',
    category: 'scheduling',
  },
  {
    key: 'pipelineId',
    column: 'pipeline',
    labelToken: 'pipeline',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'stageId',
    column: 'stage',
    labelToken: 'stage',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'probability',
    labelToken: 'probability',
    type: 'PERCENTAGE',
    category: 'status',
  },
  {
    key: 'accountId',
    column: 'account',
    labelToken: 'account',
    type: 'RELATION',
    category: 'relationship',
  },
  {
    key: 'accountName',
    labelToken: 'accountName',
    type: 'TEXT',
    category: 'relationship',
    readOnly: true,
  },
  {
    key: 'contactIds',
    column: 'contacts',
    labelToken: 'contacts',
    type: 'MULTI_LOOKUP',
    category: 'relationship',
    legacyAliases: ['contact'],
  },
  {
    key: 'ownerId',
    column: 'owner',
    labelToken: 'owner',
    type: 'USER_REFERENCE',
    category: 'assignment',
  },
  {
    key: 'sourceId',
    column: 'source',
    labelToken: 'source',
    type: 'SINGLE_SELECT',
    category: 'classification',
  },
  {
    key: 'description',
    labelToken: 'description',
    type: 'TEXTAREA',
    category: 'basic',
  },
  {
    key: 'lostReason',
    labelToken: 'lostReason',
    type: 'TEXTAREA',
    category: 'resolution',
  },
  {
    key: 'utmSource',
    labelToken: 'utmSource',
    type: 'TEXT',
    category: 'classification',
  },
  {
    key: 'utmMedium',
    labelToken: 'utmMedium',
    type: 'TEXT',
    category: 'classification',
  },
  {
    key: 'utmCampaign',
    labelToken: 'utmCampaign',
    type: 'TEXT',
    category: 'classification',
  },
  {
    key: 'nextFollowUpAt',
    labelToken: 'nextFollowUp',
    type: 'DATE',
    category: 'scheduling',
  },
  {
    key: 'tags',
    labelToken: 'tags',
    type: 'MULTI_SELECT',
    category: 'classification',
  },
  ...AUDIT_FIELDS,
] as const;

const TICKET_FIELDS: readonly StandardFieldDescriptor[] = [
  {
    key: 'ticketNumber',
    labelToken: 'ticketNumber',
    type: 'TEXT',
    category: 'basic',
    readOnly: true,
    maskable: false,
  },
  {
    key: 'subject',
    labelToken: 'subject',
    type: 'TEXT',
    category: 'basic',
    maskable: false,
  },
  {
    key: 'description',
    labelToken: 'description',
    type: 'TEXTAREA',
    category: 'basic',
  },
  {
    key: 'typeId',
    column: 'type',
    labelToken: 'type',
    type: 'SINGLE_SELECT',
    category: 'classification',
  },
  {
    key: 'categoryPath',
    column: 'category',
    labelToken: 'category',
    type: 'MULTI_SELECT',
    category: 'classification',
    // The old catalog split one path into `category` + `subCategory`; both map to
    // the single `categoryPath` array the document actually stores.
    legacyAliases: ['subCategory'],
  },
  {
    key: 'statusId',
    column: 'status',
    labelToken: 'status',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'priority',
    labelToken: 'priority',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'contactId',
    column: 'contact',
    labelToken: 'contact',
    type: 'RELATION',
    category: 'relationship',
  },
  {
    key: 'accountId',
    column: 'account',
    labelToken: 'account',
    type: 'RELATION',
    category: 'relationship',
  },
  {
    key: 'ownerId',
    column: 'owner',
    labelToken: 'owner',
    type: 'USER_REFERENCE',
    category: 'assignment',
  },
  {
    key: 'groupId',
    column: 'group',
    labelToken: 'group',
    type: 'TEAM_REFERENCE',
    category: 'assignment',
  },
  {
    key: 'sourceId',
    column: 'source',
    labelToken: 'source',
    type: 'SINGLE_SELECT',
    category: 'channel',
  },
  {
    key: 'channel',
    labelToken: 'channel',
    type: 'SINGLE_SELECT',
    category: 'channel',
  },
  {
    key: 'tags',
    labelToken: 'tags',
    type: 'MULTI_SELECT',
    category: 'classification',
  },
  {
    key: 'resolutionCodeId',
    column: 'resolutionCode',
    labelToken: 'resolutionCode',
    type: 'SINGLE_SELECT',
    category: 'resolution',
  },
  {
    key: 'resolutionNotes',
    labelToken: 'resolutionNotes',
    type: 'TEXTAREA',
    category: 'resolution',
  },
  {
    key: 'csatScore',
    labelToken: 'csatScore',
    type: 'SCORE',
    category: 'metrics',
    readOnly: true,
  },
  ...AUDIT_FIELDS,
] as const;

const TASK_FIELDS: readonly StandardFieldDescriptor[] = [
  {
    key: 'title',
    labelToken: 'subject',
    type: 'TEXT',
    category: 'basic',
    maskable: false,
    legacyAliases: ['subject'],
  },
  {
    key: 'description',
    labelToken: 'description',
    type: 'TEXTAREA',
    category: 'basic',
  },
  {
    key: 'statusId',
    column: 'status',
    labelToken: 'status',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'priority',
    labelToken: 'priority',
    type: 'SINGLE_SELECT',
    category: 'status',
  },
  {
    key: 'dueDate',
    labelToken: 'dueDate',
    type: 'DATETIME',
    category: 'scheduling',
  },
  {
    key: 'reminderAt',
    labelToken: 'reminderAt',
    type: 'DATETIME',
    category: 'scheduling',
  },
  {
    key: 'completedAt',
    labelToken: 'completedAt',
    type: 'DATETIME',
    category: 'scheduling',
    readOnly: true,
  },
  {
    key: 'ownerId',
    column: 'owner',
    labelToken: 'assignee',
    type: 'USER_REFERENCE',
    category: 'assignment',
    legacyAliases: ['assignee'],
  },
  {
    key: 'categoryId',
    column: 'category',
    labelToken: 'category',
    type: 'SINGLE_SELECT',
    category: 'classification',
  },
  {
    key: 'sourceId',
    column: 'source',
    labelToken: 'source',
    type: 'SINGLE_SELECT',
    category: 'classification',
  },
  {
    key: 'relatedTo',
    labelToken: 'relatedTo',
    type: 'RELATION',
    category: 'relationship',
  },
  {
    key: 'tags',
    labelToken: 'tags',
    type: 'MULTI_SELECT',
    category: 'classification',
  },
  ...AUDIT_FIELDS,
] as const;

export const STANDARD_FIELDS: Readonly<
  Record<ConfigurableObject, readonly StandardFieldDescriptor[]>
> = {
  Contact: CONTACT_FIELDS,
  Account: ACCOUNT_FIELDS,
  Deal: DEAL_FIELDS,
  Ticket: TICKET_FIELDS,
  Task: TASK_FIELDS,
};

/** True when a masking policy on this field would actually do something. */
export const isFieldMaskable = (field: StandardFieldDescriptor): boolean =>
  field.maskable !== false && isMaskableFieldType(field.type);

/**
 * True when the field can carry `isRequired`.
 *
 * Read-only fields cannot: the server sets them, so a required check on one
 * produces a 422 the user has no way to satisfy. That is exactly the shape of the
 * Ticket `type` bug, and refusing it here is what stops the next one.
 */
export const isFieldRequirable = (field: StandardFieldDescriptor): boolean =>
  !field.readOnly && !field.audit;
