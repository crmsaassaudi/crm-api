import { AssignmentObjectType, ConditionOperator } from './assignment.types';

/**
 * The fields a rule may condition on, per objectType.
 *
 * This registry exists for **validation and UI**, not for resolution: the
 * adapter builds the attribute bag with these exact keys and the evaluator does
 * a plain lookup. The old omni evaluator resolved fields through a
 * `switch (field)`, which meant adding a routing field required editing the
 * evaluator, and an unknown field silently evaluated to `undefined` (never
 * matching) with no error anywhere.
 */
export interface AssignmentFieldDef {
  /** Key in the attribute bag. */
  key: string;
  /** i18n key suffix — `assignment.field.<labelKey>`. */
  labelKey: string;
  type: 'text' | 'number' | 'date' | 'enum' | 'list' | 'id';
  /** Allowed values when `type === 'enum'`. */
  options?: readonly string[];
}

const TEXT_OPERATORS: readonly ConditionOperator[] = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'starts_with',
  'ends_with',
  'is_empty',
  'is_not_empty',
];

const NUMBER_OPERATORS: readonly ConditionOperator[] = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
];

const LIST_OPERATORS: readonly ConditionOperator[] = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
];

const ID_OPERATORS: readonly ConditionOperator[] = [
  'eq',
  'neq',
  'in',
  'not_in',
  'is_empty',
  'is_not_empty',
];

export function operatorsForFieldType(
  type: AssignmentFieldDef['type'],
): readonly ConditionOperator[] {
  switch (type) {
    case 'number':
    case 'date':
      return NUMBER_OPERATORS;
    case 'list':
      return LIST_OPERATORS;
    case 'id':
      return ID_OPERATORS;
    default:
      return TEXT_OPERATORS;
  }
}

/** Fields every objectType shares. */
const COMMON_FIELDS: readonly AssignmentFieldDef[] = [
  {
    key: 'business_hours',
    labelKey: 'businessHours',
    type: 'enum',
    options: ['inside', 'outside'],
  },
  { key: 'org_unit', labelKey: 'orgUnit', type: 'id' },
  { key: 'tag', labelKey: 'tag', type: 'list' },
  { key: 'time', labelKey: 'time', type: 'text' },
];

const CONVERSATION_FIELDS: readonly AssignmentFieldDef[] = [
  { key: 'channel', labelKey: 'channel', type: 'text' },
  { key: 'channel_id', labelKey: 'channelId', type: 'id' },
  { key: 'customer_name', labelKey: 'customerName', type: 'text' },
  { key: 'content', labelKey: 'messageContent', type: 'text' },
  { key: 'segment', labelKey: 'segment', type: 'text' },
  { key: 'language', labelKey: 'language', type: 'text' },
];

const RECORD_FIELDS: readonly AssignmentFieldDef[] = [
  { key: 'source', labelKey: 'source', type: 'text' },
  { key: 'ownerId', labelKey: 'currentOwner', type: 'id' },
];

const PER_OBJECT_FIELDS: Record<
  AssignmentObjectType,
  readonly AssignmentFieldDef[]
> = {
  Conversation: CONVERSATION_FIELDS,
  Lead: [
    ...RECORD_FIELDS,
    { key: 'lifecycleStage', labelKey: 'lifecycleStage', type: 'text' },
    { key: 'leadScore', labelKey: 'leadScore', type: 'number' },
    { key: 'country', labelKey: 'country', type: 'text' },
    { key: 'city', labelKey: 'city', type: 'text' },
  ],
  Contact: [
    ...RECORD_FIELDS,
    { key: 'lifecycleStage', labelKey: 'lifecycleStage', type: 'text' },
    { key: 'leadScore', labelKey: 'leadScore', type: 'number' },
    { key: 'country', labelKey: 'country', type: 'text' },
    { key: 'city', labelKey: 'city', type: 'text' },
  ],
  Account: [
    ...RECORD_FIELDS,
    { key: 'industry', labelKey: 'industry', type: 'text' },
    { key: 'annualRevenue', labelKey: 'annualRevenue', type: 'number' },
    { key: 'employeeCount', labelKey: 'employeeCount', type: 'number' },
  ],
  Ticket: [
    ...RECORD_FIELDS,
    { key: 'priority', labelKey: 'priority', type: 'text' },
    { key: 'ticketTypeId', labelKey: 'ticketType', type: 'id' },
    { key: 'statusId', labelKey: 'status', type: 'id' },
    { key: 'channel', labelKey: 'channel', type: 'text' },
  ],
  Task: [
    ...RECORD_FIELDS,
    { key: 'priority', labelKey: 'priority', type: 'text' },
    { key: 'taskTypeId', labelKey: 'taskType', type: 'id' },
    { key: 'dueDate', labelKey: 'dueDate', type: 'date' },
  ],
  Deal: [
    ...RECORD_FIELDS,
    { key: 'amount', labelKey: 'amount', type: 'number' },
    { key: 'currency', labelKey: 'currency', type: 'text' },
    { key: 'pipelineId', labelKey: 'pipeline', type: 'id' },
    { key: 'stageId', labelKey: 'stage', type: 'id' },
    { key: 'closeDate', labelKey: 'closeDate', type: 'date' },
  ],
};

/**
 * Built-in fields for an objectType. Custom fields are additive and validated
 * separately (a tenant's custom field is a legitimate condition target but
 * cannot be listed statically here).
 */
export function builtInFieldsFor(
  objectType: AssignmentObjectType,
): AssignmentFieldDef[] {
  return [...PER_OBJECT_FIELDS[objectType], ...COMMON_FIELDS];
}
