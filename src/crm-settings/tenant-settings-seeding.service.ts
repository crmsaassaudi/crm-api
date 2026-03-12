import { Injectable, Logger } from '@nestjs/common';
import { CrmSettingRepository } from './infrastructure/persistence/document/repositories/crm-setting.repository';

/**
 * Seeds default CRM settings for a newly created tenant.
 *
 * Strategy:
 *  - "Hard defaults": purely technical flags (conversion, assignment, communication).
 *    These are seeded automatically and typically don't require immediate user action.
 *  - "Starter templates": business-facing configurations such as Contact Lifecycle Stages
 *    and Deal Pipeline that the tenant SHOULD customise. They are seeded with sensible
 *    industry-standard values so the CRM works out of the box, but every value is
 *    editable in Settings.
 */
@Injectable()
export class TenantSettingsSeedingService {
  private readonly logger = new Logger(TenantSettingsSeedingService.name);

  constructor(private readonly repository: CrmSettingRepository) {}

  async seedDefaults(tenantId: string): Promise<void> {
    this.logger.log(
      `[Seeding] Seeding default settings for tenant ${tenantId}`,
    );

    await Promise.all([
      // ── Contact ────────────────────────────────────────────────────────────
      this.seed(tenantId, 'contact_identity', DEFAULT_CONTACT_IDENTITY),
      this.seed(tenantId, 'contact_relationship', DEFAULT_CONTACT_RELATIONSHIP),
      this.seed(
        tenantId,
        'contact_communication',
        DEFAULT_CONTACT_COMMUNICATION,
      ),
      this.seed(tenantId, 'contact_roles', DEFAULT_CONTACT_ROLES),
      this.seed(tenantId, 'contact_assignment', DEFAULT_CONTACT_ASSIGNMENT),
      this.seed(tenantId, 'contact_conversion', DEFAULT_CONTACT_CONVERSION),
      this.seed(tenantId, 'contact_source', DEFAULT_CONTACT_SOURCE),

      // ── Contact & Account Lifecycle (starter template — tenant customises) -
      this.seed(tenantId, 'contact_lifecycle', DEFAULT_CONTACT_LIFECYCLE),
      this.seed(tenantId, 'account_lifecycle', DEFAULT_ACCOUNT_LIFECYCLE),

      // ── Deal ───────────────────────────────────────────────────────────────
      this.seed(tenantId, 'deal_pipeline', DEFAULT_DEAL_PIPELINE),
      this.seed(tenantId, 'deal_forecasting', DEFAULT_DEAL_FORECASTING),
      this.seed(tenantId, 'deal_sales_goals', DEFAULT_DEAL_SALES_GOALS),

      // ── Account ────────────────────────────────────────────────────────────
      this.seed(tenantId, 'account_structure', DEFAULT_ACCOUNT_STRUCTURE),
      this.seed(
        tenantId,
        'account_classification',
        DEFAULT_ACCOUNT_CLASSIFICATION,
      ),
      this.seed(tenantId, 'account_territory', DEFAULT_ACCOUNT_TERRITORY),
      this.seed(tenantId, 'account_financial', DEFAULT_ACCOUNT_FINANCIAL),

      // ── Task ───────────────────────────────────────────────────────────────
      this.seed(tenantId, 'task_advanced', DEFAULT_TASK_ADVANCED),

      // ── Layout & Validation ────────────────────────────────────────────────
      this.seed(tenantId, 'layout_settings', DEFAULT_LAYOUT_SETTINGS),
      this.seed(tenantId, 'validation_rules', DEFAULT_VALIDATION_RULES),

      // ── Business Hours ─────────────────────────────────────────────────────
      this.seed(tenantId, 'business_hours', DEFAULT_BUSINESS_HOURS),
    ]);

    this.logger.log(`[Seeding] Completed for tenant ${tenantId}`);
  }

  /**
   * Returns the hardcoded default value for a given settings key,
   * or `undefined` if the key has no registered default.
   * Used by CrmSettingsService for lazy seeding on existing tenants.
   */
  getDefault(key: string): unknown | undefined {
    return DEFAULTS_MAP[key];
  }

  /**
   * Seeds a single key for a tenant if it has no value yet.
   * Returns the stored (or newly seeded) value, or null when there is no default.
   */
  async lazySeed(tenantId: string, key: string): Promise<unknown | null> {
    const defaultValue = DEFAULTS_MAP[key];
    if (defaultValue === undefined) return null;
    try {
      await this.repository.update(tenantId, key, defaultValue);
      this.logger.log(`[Seeding] Lazy-seeded "${key}" for tenant ${tenantId}`);
      return defaultValue;
    } catch (err) {
      this.logger.error(
        `[Seeding] Failed to lazy-seed "${key}" for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  /** Inserts a setting only if it does not already exist for the tenant. */
  private async seed(
    tenantId: string,
    key: string,
    value: unknown,
  ): Promise<void> {
    try {
      const existing = await this.repository.findOne(tenantId, key);
      if (existing) return; // never overwrite user-configured data
      await this.repository.update(tenantId, key, value);
    } catch (err) {
      this.logger.error(
        `[Seeding] Failed to seed "${key}" for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

// ─── Default values ──────────────────────────────────────────────────────────

const DEFAULT_CONTACT_IDENTITY = {
  duplicateDetectionEnabled: true,
  duplicateFields: ['email', 'phone'],
  mergeStrategy: 'manual',
};

const DEFAULT_CONTACT_RELATIONSHIP = {
  enableHousehold: false,
  enableCompanyLink: true,
  maxRelationships: 20,
};

const DEFAULT_CONTACT_COMMUNICATION = {
  defaultChannel: 'email',
  unsubscribeEnabled: true,
  gdprConsentRequired: false,
};

const DEFAULT_CONTACT_ROLES = {
  roles: [
    { id: 'decision_maker', name: 'Decision Maker' },
    { id: 'influencer', name: 'Influencer' },
    { id: 'end_user', name: 'End User' },
    { id: 'champion', name: 'Champion' },
    { id: 'economic_buyer', name: 'Economic Buyer' },
  ],
};

const DEFAULT_CONTACT_ASSIGNMENT = {
  autoAssignmentEnabled: false,
  strategy: 'round_robin',
  maxContactsPerAgent: 50,
  fallbackRule: 'unassigned_queue',
  reassignmentRule: 'after_24h_inactivity',
};

const DEFAULT_CONTACT_CONVERSION = {
  allowConversion: true,
  convertToAccount: true,
  convertToDeal: true,
  autoMergeOnConvert: false,
};

const DEFAULT_CONTACT_SOURCE = {
  sources: [
    { id: '1', name: 'Website' },
    { id: '2', name: 'Facebook' },
    { id: '3', name: 'Google Ads' },
  ],
  utmMappingEnabled: true,
  autoSourceDetectionEnabled: true,
};

/**
 * Contact Lifecycle Stages — starter template.
 * Based on a common B2B/B2C funnel: Subscriber → Lead → MQL → SQL → Opportunity → Customer.
 * Tenants are expected to customise stages, colours, and statuses in Settings > Contacts > Lifecycle.
 */
const DEFAULT_CONTACT_LIFECYCLE = {
  pipelineEnabled: true,
  autoExpireDays: null,
  autoCloseRule: null,
  reopenRule: 'on_new_activity',
  stages: [
    {
      id: 'subscriber',
      name: 'Subscriber',
      apiName: 'subscriber',
      sortOrder: 1,
      color: '#64748b',
      statuses: [
        {
          id: 'new_sub',
          label: 'New Subscriber',
          apiName: 'new_subscriber',
          sortOrder: 1,
          color: '#3b82f6',
          isDefault: true,
        },
        {
          id: 'engaged',
          label: 'Engaged',
          apiName: 'engaged',
          sortOrder: 2,
          color: '#10b981',
        },
        {
          id: 'unsubscribed',
          label: 'Unsubscribed',
          apiName: 'unsubscribed',
          sortOrder: 3,
          color: '#ef4444',
          isTerminal: true,
        },
      ],
    },
    {
      id: 'lead',
      name: 'Lead',
      apiName: 'lead',
      sortOrder: 2,
      color: '#3b82f6',
      statuses: [
        {
          id: 'new',
          label: 'New',
          apiName: 'new',
          sortOrder: 1,
          color: '#3b82f6',
          isDefault: true,
        },
        {
          id: 'contacting',
          label: 'Contacting',
          apiName: 'contacting',
          sortOrder: 2,
          color: '#eab308',
        },
        {
          id: 'nurturing',
          label: 'Nurturing',
          apiName: 'nurturing',
          sortOrder: 3,
          color: '#a855f7',
        },
        {
          id: 'disqualified',
          label: 'Disqualified',
          apiName: 'disqualified',
          sortOrder: 4,
          color: '#ef4444',
          isTerminal: true,
        },
      ],
    },
    {
      id: 'mql',
      name: 'MQL',
      apiName: 'mql',
      sortOrder: 3,
      color: '#6366f1',
      statuses: [
        {
          id: 'qualified',
          label: 'Qualified',
          apiName: 'qualified',
          sortOrder: 1,
          color: '#6366f1',
          isDefault: true,
        },
        {
          id: 'handover_to_sales',
          label: 'Handover to Sales',
          apiName: 'handover_to_sales',
          sortOrder: 2,
          color: '#10b981',
        },
      ],
    },
    {
      id: 'sql',
      name: 'SQL',
      apiName: 'sql',
      sortOrder: 4,
      color: '#8b5cf6',
      statuses: [
        {
          id: 'discovery_call_scheduled',
          label: 'Discovery Call Scheduled',
          apiName: 'discovery_call_scheduled',
          sortOrder: 1,
          color: '#8b5cf6',
          isDefault: true,
        },
        {
          id: 'needs_analysis',
          label: 'Needs Analysis',
          apiName: 'needs_analysis',
          sortOrder: 2,
          color: '#3b82f6',
        },
        {
          id: 'demo_scheduled',
          label: 'Demo Scheduled',
          apiName: 'demo_scheduled',
          sortOrder: 3,
          color: '#10b981',
        },
      ],
    },
    {
      id: 'opportunity',
      name: 'Opportunity',
      apiName: 'opportunity',
      sortOrder: 5,
      color: '#f97316',
      statuses: [
        {
          id: 'proposal_sent',
          label: 'Proposal Sent',
          apiName: 'proposal_sent',
          sortOrder: 1,
          color: '#f97316',
          isDefault: true,
        },
        {
          id: 'negotiation',
          label: 'Negotiation',
          apiName: 'negotiation',
          sortOrder: 2,
          color: '#f59e0b',
        },
        {
          id: 'closed_won',
          label: 'Closed Won',
          apiName: 'closed_won',
          sortOrder: 3,
          color: '#10b981',
          isTerminal: true,
        },
        {
          id: 'closed_lost',
          label: 'Closed Lost',
          apiName: 'closed_lost',
          sortOrder: 4,
          color: '#f43f5e',
          isTerminal: true,
        },
      ],
    },
    {
      id: 'customer',
      name: 'Customer',
      apiName: 'customer',
      sortOrder: 6,
      color: '#10b981',
      isConverted: true,
      statuses: [
        {
          id: 'onboarding',
          label: 'Onboarding',
          apiName: 'onboarding',
          sortOrder: 1,
          color: '#3b82f6',
          isDefault: true,
        },
        {
          id: 'active',
          label: 'Active',
          apiName: 'active',
          sortOrder: 2,
          color: '#10b981',
        },
        {
          id: 'churned',
          label: 'Churned',
          apiName: 'churned',
          sortOrder: 3,
          color: '#64748b',
          isTerminal: true,
        },
      ],
    },
  ],
};

const DEFAULT_ACCOUNT_LIFECYCLE = {
  pipelineEnabled: true,
  stages: [
    {
      id: 'prospect',
      name: 'Prospect',
      apiName: 'prospect',
      sortOrder: 1,
      color: '#64748b',
      statuses: [
        {
          id: 'new',
          label: 'New',
          apiName: 'new',
          sortOrder: 1,
          color: '#3b82f6',
          isDefault: true,
        },
        {
          id: 'contacted',
          label: 'Contacted',
          apiName: 'contacted',
          sortOrder: 2,
          color: '#eab308',
        },
      ],
    },
    {
      id: 'customer',
      name: 'Customer',
      apiName: 'customer',
      sortOrder: 2,
      color: '#10b981',
      isConverted: true,
      statuses: [
        {
          id: 'active',
          label: 'Active',
          apiName: 'active',
          sortOrder: 1,
          color: '#10b981',
          isDefault: true,
        },
        {
          id: 'churned',
          label: 'Churned',
          apiName: 'churned',
          sortOrder: 2,
          color: '#64748b',
          isTerminal: true,
        },
      ],
    },
  ],
};

/**
 * Deal Pipeline — starter template.
 * A single default pipeline with the classic qualification → closed stages.
 * Tenants can rename stages, adjust probabilities, or create additional pipelines.
 */
const DEFAULT_DEAL_PIPELINE = {
  id: 'default',
  name: 'Default Pipeline',
  isDefault: true,
  stages: [
    {
      id: '1',
      name: 'Qualification',
      apiName: 'qualification',
      probability: 10,
      daysInStage: 14,
      color: '#64748b',
    },
    {
      id: '2',
      name: 'Proposal',
      apiName: 'proposal',
      probability: 40,
      daysInStage: 14,
      color: '#3b82f6',
    },
    {
      id: '3',
      name: 'Negotiation',
      apiName: 'negotiation',
      probability: 70,
      daysInStage: 10,
      color: '#f59e0b',
    },
    {
      id: '4',
      name: 'Closed Won',
      apiName: 'closed_won',
      probability: 100,
      daysInStage: 0,
      color: '#10b981',
      isTerminal: true,
      isWon: true,
    },
    {
      id: '5',
      name: 'Closed Lost',
      apiName: 'closed_lost',
      probability: 0,
      daysInStage: 0,
      color: '#ef4444',
      isTerminal: true,
      isWon: false,
    },
  ],
};

const DEFAULT_DEAL_FORECASTING = {
  weightedForecast: true,
  currency: 'USD',
  fiscalYearStart: 'January',
  forecastCategories: [
    { name: 'Commit', minProbability: 80, maxProbability: 100 },
    { name: 'Best Case', minProbability: 50, maxProbability: 79 },
    { name: 'Pipeline', minProbability: 10, maxProbability: 49 },
    { name: 'Omitted', minProbability: 0, maxProbability: 9 },
  ],
};

const DEFAULT_DEAL_SALES_GOALS = {
  teamGoalsEnabled: false,
  individualGoalsEnabled: false,
  goalPeriod: 'quarterly',
};

// ─── Account defaults ────────────────────────────────────────────────────────

const DEFAULT_ACCOUNT_STRUCTURE = {
  enableParentChildHierarchy: true,
  maxHierarchyDepth: 5,
};

const DEFAULT_ACCOUNT_CLASSIFICATION = {
  accountTypes: [
    { id: '1', name: 'Customer' },
    { id: '2', name: 'Partner' },
    { id: '3', name: 'Reseller' },
  ],
  industries: ['Technology', 'Finance', 'Healthcare', 'Retail', 'Logistics'],
};

const DEFAULT_ACCOUNT_TERRITORY = {
  autoOwnerAssignment: true,
};

const DEFAULT_ACCOUNT_FINANCIAL = {
  multiCurrency: true,
};

// ─── Task defaults ───────────────────────────────────────────────────────────

const DEFAULT_TASK_ADVANCED = {
  categories: [
    {
      id: '1',
      name: 'Call',
      apiName: 'call',
      icon: 'Phone',
      color: '#3b82f6',
    },
    {
      id: '2',
      name: 'Email',
      apiName: 'email',
      icon: 'Mail',
      color: '#6366f1',
    },
    {
      id: '3',
      name: 'Meeting',
      apiName: 'meeting',
      icon: 'Users',
      color: '#8b5cf6',
    },
    {
      id: '4',
      name: 'To-do',
      apiName: 'todo',
      icon: 'CheckSquare',
      color: '#64748b',
    },
  ],
  defaultReminderMinutes: 15,
  enableAutoCompletionRules: true,
};

// ─── Layout & Validation defaults ────────────────────────────────────────────

const DEFAULT_LAYOUT_SETTINGS = {
  groupLayouts: {
    default: {
      Lead: [],
      Contact: [],
      Account: [],
      Deal: [],
      Ticket: [],
      Task: [],
    },
  },
};

const DEFAULT_VALIDATION_RULES = {
  rules: {
    Contact: [
      {
        id: '1',
        name: 'Email Format Check',
        field: 'email',
        operator: 'regex',
        value: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
        errorMessage: 'Please enter a valid email address.',
        isActive: true,
      },
    ],
  },
};

// ─── Business Hours default ──────────────────────────────────────────────────

const DEFAULT_BUSINESS_HOURS = {
  timezone: 'ict',
  weekStartDay: 'monday',
  workingDays: [
    {
      day: 'Monday',
      enabled: true,
      slots: [{ start: '08:00', end: '17:00' }],
    },
    {
      day: 'Tuesday',
      enabled: true,
      slots: [{ start: '08:00', end: '17:00' }],
    },
    {
      day: 'Wednesday',
      enabled: true,
      slots: [{ start: '08:00', end: '17:00' }],
    },
    {
      day: 'Thursday',
      enabled: true,
      slots: [{ start: '08:00', end: '17:00' }],
    },
    {
      day: 'Friday',
      enabled: true,
      slots: [{ start: '08:00', end: '17:00' }],
    },
    {
      day: 'Saturday',
      enabled: false,
      slots: [{ start: '08:00', end: '17:00' }],
    },
    {
      day: 'Sunday',
      enabled: false,
      slots: [{ start: '08:00', end: '17:00' }],
    },
  ],
  holidays: [],
  oooConfig: {
    enableAutoReply: true,
    templateId: 'default-ooo',
    queueMessages: true,
  },
};

/** Lookup map used by lazySeed() and getDefault(). Add new keys here when a new module ships. */
export const DEFAULTS_MAP: Record<string, unknown> = {
  contact_identity: DEFAULT_CONTACT_IDENTITY,
  contact_relationship: DEFAULT_CONTACT_RELATIONSHIP,
  contact_communication: DEFAULT_CONTACT_COMMUNICATION,
  contact_roles: DEFAULT_CONTACT_ROLES,
  contact_assignment: DEFAULT_CONTACT_ASSIGNMENT,
  contact_conversion: DEFAULT_CONTACT_CONVERSION,
  contact_source: DEFAULT_CONTACT_SOURCE,
  contact_lifecycle: DEFAULT_CONTACT_LIFECYCLE,
  account_lifecycle: DEFAULT_ACCOUNT_LIFECYCLE,
  deal_pipeline: DEFAULT_DEAL_PIPELINE,
  deal_forecasting: DEFAULT_DEAL_FORECASTING,
  deal_sales_goals: DEFAULT_DEAL_SALES_GOALS,
  account_structure: DEFAULT_ACCOUNT_STRUCTURE,
  account_classification: DEFAULT_ACCOUNT_CLASSIFICATION,
  account_territory: DEFAULT_ACCOUNT_TERRITORY,
  account_financial: DEFAULT_ACCOUNT_FINANCIAL,
  task_advanced: DEFAULT_TASK_ADVANCED,
  layout_settings: DEFAULT_LAYOUT_SETTINGS,
  validation_rules: DEFAULT_VALIDATION_RULES,
  business_hours: DEFAULT_BUSINESS_HOURS,
};
