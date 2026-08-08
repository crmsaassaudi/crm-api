import { Injectable, Logger } from '@nestjs/common';
import { CrmSettingRepository } from './infrastructure/persistence/document/repositories/crm-setting.repository';
import { DEFAULT_EMAIL_SETTINGS } from '../channels/domain/email-settings.defaults';
import {
  DEAL_RULES_SETTING_KEY,
  DEFAULT_DEAL_RULES,
} from '../deals/deals.constants';

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
      // Contact
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

      // Contact & Account Lifecycle (starter template — tenant customises)
      this.seed(tenantId, 'contact_lifecycle', DEFAULT_CONTACT_LIFECYCLE),
      this.seed(tenantId, 'account_lifecycle', DEFAULT_ACCOUNT_LIFECYCLE),

      // Deal — the pipeline itself lives in `deal_pipelines`/`deal_stages`
      // (DealPipelineSeederService); only rules and forecasting are settings.
      this.seed(tenantId, DEAL_RULES_SETTING_KEY, DEFAULT_DEAL_RULES),
      this.seed(tenantId, 'deal_forecasting', DEFAULT_DEAL_FORECASTING),
      this.seed(tenantId, 'deal_sales_goals', DEFAULT_DEAL_SALES_GOALS),

      // Account
      this.seed(tenantId, 'account_structure', DEFAULT_ACCOUNT_STRUCTURE),
      this.seed(
        tenantId,
        'account_classification',
        DEFAULT_ACCOUNT_CLASSIFICATION,
      ),
      this.seed(tenantId, 'account_territory', DEFAULT_ACCOUNT_TERRITORY),
      this.seed(tenantId, 'account_financial', DEFAULT_ACCOUNT_FINANCIAL),

      // Task
      this.seed(tenantId, 'task_advanced', DEFAULT_TASK_ADVANCED),

      // Layout & Validation
      this.seed(tenantId, 'layout_settings', DEFAULT_LAYOUT_SETTINGS),
      this.seed(tenantId, 'validation_rules', DEFAULT_VALIDATION_RULES),

      // Business Hours
      this.seed(tenantId, 'business_hours', DEFAULT_BUSINESS_HOURS),

      // Omni Routing & Assignment
      this.seed(tenantId, 'omni_routing', DEFAULT_OMNI_ROUTING),

      // Omni Agent Presence / Workforce
      this.seed(tenantId, 'omni_presence', DEFAULT_OMNI_PRESENCE),
      this.seed(tenantId, 'omni_capacity', DEFAULT_OMNI_CAPACITY),

      // Omni Session Lifecycle
      this.seed(
        tenantId,
        'omni_session_lifecycle',
        DEFAULT_OMNI_SESSION_LIFECYCLE,
      ),

      // Omni Identity Resolution
      this.seed(
        tenantId,
        'omni_identity_resolution',
        DEFAULT_OMNI_IDENTITY_RESOLUTION,
      ),

      // Omni Auto-Reassignment
      this.seed(
        tenantId,
        'omni_auto_reassignment',
        DEFAULT_OMNI_AUTO_REASSIGNMENT,
      ),

      // General Settings
      this.seed(tenantId, 'general_profile', DEFAULT_GENERAL_PROFILE),
      this.seed(tenantId, 'general_localization', DEFAULT_GENERAL_LOCALIZATION),
      this.seed(
        tenantId,
        'general_notifications',
        DEFAULT_GENERAL_NOTIFICATIONS,
      ),

      // Data Visibility & Sharing
      this.seed(tenantId, 'data_visibility', DEFAULT_DATA_VISIBILITY),
      this.seed(tenantId, 'sharing_rules', DEFAULT_SHARING_RULES),

      // List Views
      this.seed(tenantId, 'list_views', DEFAULT_LIST_VIEWS),

      // Email Channel Settings
      this.seed(tenantId, 'email_settings', DEFAULT_EMAIL_SETTINGS),

      // Navigation
      this.seed(
        tenantId,
        'navigation_workspaces',
        DEFAULT_NAVIGATION_WORKSPACES,
      ),
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

// Default values

const DEFAULT_CONTACT_IDENTITY = {
  uniqueEmail: true,
  uniquePhone: true,
  multipleEmailsAllowed: false,
  multiplePhonesAllowed: false,
  mergePolicy: 'manual_review',
};

const DEFAULT_CONTACT_RELATIONSHIP = {
  relationshipModel: 'one_to_many',
  contactHierarchyEnabled: true,
};

const DEFAULT_CONTACT_COMMUNICATION = {
  emailOptInTracking: true,
  smsOptInTracking: false,
  whatsappOptInTracking: false,
  doNotCallFlag: false,
  gdprConsentTracking: true,
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
      // Marks this stage as the one the lead→won conversion report counts
      // from. Tenants that rename/remove/add stages control this per stage in
      // Settings → Contacts → Lifecycle, same as a deal stage's isWon/isLost.
      isLeadStage: true,
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
  pipelineEnabled: false,
  stages: [
    {
      id: 'account_status',
      name: 'Account Status',
      apiName: 'account_status',
      sortOrder: 1,
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
          id: 'contacted',
          label: 'Contacted',
          apiName: 'contacted',
          sortOrder: 2,
          color: '#eab308',
        },
        {
          id: 'active',
          label: 'Active',
          apiName: 'active',
          sortOrder: 3,
          color: '#10b981',
        },
        {
          id: 'churned',
          label: 'Churned',
          apiName: 'churned',
          sortOrder: 4,
          color: '#64748b',
          isTerminal: true,
        },
      ],
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

// Layout & Validation defaults

const DEFAULT_SECTION_CONFIGS = {
  Contact: [
    {
      id: 'general',
      label: 'General Information',
      sortOrder: 1,
      visibleAtStages: [],
    },
    {
      id: 'marketing_attribution',
      label: 'Marketing Attribution',
      sortOrder: 2,
      visibleAtStages: [],
    },
    {
      id: 'sales_qualification',
      label: 'Sales Qualification',
      sortOrder: 3,
      visibleAtStages: [],
    },
    {
      id: 'financial_info',
      label: 'Financial Information',
      sortOrder: 4,
      visibleAtStages: [],
    },
    { id: 'custom', label: 'Custom Fields', sortOrder: 5, visibleAtStages: [] },
  ],
  Account: [
    {
      id: 'general',
      label: 'General Information',
      sortOrder: 1,
      visibleAtStages: [],
    },
    {
      id: 'financial_info',
      label: 'Financial Information',
      sortOrder: 2,
      visibleAtStages: [],
    },
    { id: 'custom', label: 'Custom Fields', sortOrder: 3, visibleAtStages: [] },
  ],
  Deal: [
    {
      id: 'general',
      label: 'General Information',
      sortOrder: 1,
      visibleAtStages: [],
    },
    {
      id: 'deal_details',
      label: 'Deal Details',
      sortOrder: 2,
      visibleAtStages: [],
    },
    { id: 'custom', label: 'Custom Fields', sortOrder: 3, visibleAtStages: [] },
  ],
  Ticket: [
    {
      id: 'general',
      label: 'General Information',
      sortOrder: 1,
      visibleAtStages: [],
    },
    { id: 'custom', label: 'Custom Fields', sortOrder: 2, visibleAtStages: [] },
  ],
  Task: [
    {
      id: 'general',
      label: 'General Information',
      sortOrder: 1,
      visibleAtStages: [],
    },
    { id: 'custom', label: 'Custom Fields', sortOrder: 2, visibleAtStages: [] },
  ],
};

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
  sectionConfigs: DEFAULT_SECTION_CONFIGS,
};

const DEFAULT_VALIDATION_RULES = {
  rules: {
    Contact: [
      {
        id: '1',
        name: 'Email Format Check',
        field: 'emails',
        operator: 'regex',
        value: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
        errorMessage: 'Please enter a valid email address.',
        isActive: true,
      },
    ],
  },
};

const DEFAULT_BUSINESS_HOURS = {
  /**
   * An IANA zone identifier, and the same value `general_localization` seeds.
   *
   * This used to be `'ict'`, which is not an IANA zone — `Intl` rejects it, so
   * BusinessHoursService caught the error and fell back to UTC. Every new
   * tenant therefore ran its schedule seven hours off what the settings screen
   * claimed, and nothing said so. Two defaults for the same concept is how
   * that stayed invisible; there is one now.
   */
  timezone: 'UTC',
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

const DEFAULT_GENERAL_PROFILE = {
  tenantName: 'My Organization',
  logoUrl: '',
};

const DEFAULT_GENERAL_LOCALIZATION = {
  language: 'en',
  timezone: 'UTC',
  currency: 'USD',
};

const DEFAULT_GENERAL_NOTIFICATIONS = {
  emailNotifications: true,
  marketingEmails: false,
};

const DEFAULT_ACCOUNT_SOURCE = {
  sources: [
    { id: '1', name: 'Web Search' },
    { id: '2', name: 'Referral' },
    { id: '3', name: 'Sales Outbound' },
    { id: '4', name: 'Partner' },
  ],
};

const DEFAULT_DEAL_SOURCE = {
  sources: [
    { id: '1', name: 'Existing Customer' },
    { id: '2', name: 'Inbound Inquiry' },
    { id: '3', name: 'Event/Tradeshow' },
    { id: '4', name: 'Referral' },
  ],
};

const DEFAULT_TICKET_SOURCE = {
  sources: [
    { id: '1', name: 'Email' },
    { id: '2', name: 'Phone' },
    { id: '3', name: 'Client Portal' },
    { id: '4', name: 'Chat' },
    { id: '5', name: 'Social Media' },
  ],
};

const DEFAULT_TASK_SOURCE = {
  sources: [
    { id: '1', name: 'System Generated' },
    { id: '2', name: 'Manual' },
    { id: '3', name: 'Workflow' },
  ],
};

// Ticket Type / Category / Resolution defaults

const DEFAULT_TICKET_TYPE = {
  types: [
    {
      id: '1',
      name: 'Incident',
      apiName: 'incident',
      description: 'Something is broken or not working correctly',
      color: '#ef4444',
    },
    {
      id: '2',
      name: 'Question',
      apiName: 'question',
      description: 'Customer has a question or needs information',
      color: '#3b82f6',
    },
    {
      id: '3',
      name: 'Request',
      apiName: 'request',
      description: 'Service request or feature request',
      color: '#8b5cf6',
    },
    {
      id: '4',
      name: 'Problem',
      apiName: 'problem',
      description: 'Root cause of one or more incidents',
      color: '#f59e0b',
    },
    {
      id: '5',
      name: 'Task',
      apiName: 'task',
      description: 'Internal task related to support operations',
      color: '#64748b',
    },
  ],
};

/**
 * Category tree with recursive children (n-level depth).
 * Default seed: 2 levels (Category → Sub-Category).
 * Each node: { id, name, apiName, children?: CategoryNode[] }
 */
const DEFAULT_TICKET_CATEGORY = {
  categories: [
    {
      id: '1',
      name: 'Billing',
      apiName: 'billing',
      children: [
        { id: '1a', name: 'Refund', apiName: 'refund', children: [] },
        {
          id: '1b',
          name: 'Invoice Issue',
          apiName: 'invoice_issue',
          children: [],
        },
        {
          id: '1c',
          name: 'Payment Failed',
          apiName: 'payment_failed',
          children: [],
        },
      ],
    },
    {
      id: '2',
      name: 'Technical',
      apiName: 'technical',
      children: [
        { id: '2a', name: 'Server Down', apiName: 'server_down', children: [] },
        { id: '2b', name: 'Bug Report', apiName: 'bug_report', children: [] },
        {
          id: '2c',
          name: 'Change Password',
          apiName: 'change_password',
          children: [],
        },
        { id: '2d', name: 'Integration', apiName: 'integration', children: [] },
      ],
    },
    {
      id: '3',
      name: 'Sales',
      apiName: 'sales',
      children: [
        { id: '3a', name: 'Pricing', apiName: 'pricing', children: [] },
        {
          id: '3b',
          name: 'Upgrade/Downgrade',
          apiName: 'upgrade_downgrade',
          children: [],
        },
      ],
    },
    {
      id: '4',
      name: 'General',
      apiName: 'general',
      children: [],
    },
  ],
};

const DEFAULT_TICKET_RESOLUTION = {
  codes: [
    { id: '1', name: 'Fixed', apiName: 'fixed' },
    { id: '2', name: 'Duplicate', apiName: 'duplicate' },
    { id: '3', name: "Won't Fix", apiName: 'wont_fix' },
    { id: '4', name: 'User Error', apiName: 'user_error' },
    { id: '5', name: 'Not Reproducible', apiName: 'not_reproducible' },
    { id: '6', name: 'By Design', apiName: 'by_design' },
    { id: '7', name: 'Workaround Provided', apiName: 'workaround_provided' },
  ],
};

const DEFAULT_TICKET_LIFECYCLE = {
  stages: [
    {
      id: 'support_pipeline',
      name: 'Ticket Support',
      apiName: 'support',
      sortOrder: 1,
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
          id: 'open',
          label: 'In Progress',
          apiName: 'open',
          sortOrder: 2,
          color: '#eab308',
        },
        {
          id: 'on_hold',
          label: 'Waiting on Customer',
          apiName: 'on_hold',
          sortOrder: 3,
          color: '#f59e0b',
          // The SLA stops here. An agent is not late because the customer took
          // the weekend to reply, and a desk with no pausing status cannot
          // report a defensible response time.
          pausesSla: true,
        },
        {
          id: 'resolved',
          label: 'Resolved',
          apiName: 'resolved',
          sortOrder: 4,
          color: '#10b981',
          isTerminal: true,
          // Resolved is not Closed: the fix is delivered, the customer has not
          // confirmed. Stamping both used to make time-to-resolve identical to
          // time-to-close and hid the state entirely.
          terminalKind: 'resolved',
        },
        {
          id: 'closed',
          label: 'Closed',
          apiName: 'closed',
          sortOrder: 5,
          color: '#64748b',
          isTerminal: true,
          terminalKind: 'closed',
        },
      ],
    },
  ],
};

const DEFAULT_TASK_LIFECYCLE = {
  stages: [
    {
      id: 'default_task_stage',
      name: 'Task Management',
      apiName: 'default',
      sortOrder: 1,
      color: '#64748b',
      statuses: [
        {
          id: 'todo',
          label: 'To Do',
          apiName: 'todo',
          sortOrder: 1,
          color: '#64748b',
          isDefault: true,
        },
        {
          id: 'in_progress',
          label: 'In Progress',
          apiName: 'in_progress',
          sortOrder: 2,
          color: '#3b82f6',
        },
        {
          id: 'completed',
          label: 'Completed',
          apiName: 'completed',
          sortOrder: 3,
          color: '#10b981',
          isTerminal: true,
        },
        {
          id: 'cancelled',
          label: 'Cancelled',
          apiName: 'cancelled',
          sortOrder: 4,
          color: '#ef4444',
          isTerminal: true,
        },
      ],
    },
  ],
};

const DEFAULT_OMNI_IDENTITY_RESOLUTION = {
  /** Auto-create a shadow CRM contact for every unknown sender */
  autoCreateShadowContact: true,
  /** Auto-fetch social profile (name, avatar, phone) via platform APIs */
  autoEnrichProfile: true,
  /** Disclaimer message for data enrichment (GDPR/PDPA) */
  enrichmentDisclaimer:
    'We collect publicly available profile information to improve your customer experience. You may request data deletion at any time.',
  /** Auto-merge shadow contact into existing contact when phone/email matches */
  autoMergeShadowContact: true,
  /** Strategy for auto-merge: 'phone_email_match' checks phone and email fields */
  autoMergeStrategy: 'phone_email_match',
};

// Omni Routing & Assignment defaults

/**
 * What is left of `omni_routing` after the assignment consolidation.
 *
 * Every routing-decision field — the master switch, strategy, capacity, sticky
 * and skill toggles — now lives in `assignment_settings` keyed by objectType,
 * seeded by AssignmentSeederService and migrated for existing tenants by
 * `migrate:assignment-consolidation`. What remains here is the one field that
 * was never a routing decision: whether an agent's presence flips to available
 * the moment their socket connects.
 */
const DEFAULT_OMNI_ROUTING = {
  autoAvailableOnConnect: false,
};

// Omni Agent Presence / Workforce defaults
// See docs/agent-presence-workforce-spec.md §8 for the rationale behind each
// default. These drive the presence state machine, heartbeat/grace timing,
// per-module routing eligibility, alerts and the agent ranking guardrails.
const DEFAULT_OMNI_PRESENCE = {
  // Heartbeat & connection (§2.3)
  /** Client heartbeat interval (seconds) */
  heartbeatIntervalSeconds: 30,
  /** Silence after which a socket is considered disconnected (seconds) */
  heartbeatTimeoutSeconds: 60,
  /** Hold state before forcing OFFLINE after all connections lost (seconds) */
  gracePeriodSeconds: 120,

  // Work status (§2.4)
  /** Window an agent stays in WRAP_UP after closing an interaction (seconds) */
  wrapUpWindowSeconds: 120,

  // Routing interlock (§1.2)
  /**
   * When returning to AVAILABLE from BREAK/MEETING/AWAY/TRAINING, auto-restore
   * ACCEPTING. Default false — agent must explicitly press "Ready".
   */
  restoreAcceptingOnReturn: false,

  // Per-module require-online for assignment (§5)
  requireOnlineForAssignment: {
    livechat: true,
    social: true,
    call: true,
    ticket: false,
    deal: false,
    task: false,
  },

  // Alerts (§4.5)
  /** Max daily BREAK budget before over-break alert (minutes) */
  breakBudgetMinutes: 60,
  /** Stay AVAILABLE+NOT_ACCEPTING this long after login → invisible-login alert (minutes) */
  loginIdleAlertMinutes: 15,
  /** AvailabilityRatio (accepting/online) below this flags low-accepting */
  minAcceptingRatio: 0.5,
  /** AWAY longer than this → alert (minutes) */
  longAwayAlertMinutes: 20,
  /** AVAILABLE+NOT_ACCEPTING continuously longer than this → alert (minutes) */
  stuckNotAcceptingAlertMinutes: 30,

  // Ranking (§4.3)
  ranking: {
    /** Agents below these thresholds appear in detail but are not ranked */
    minOnlineMinutes: 60,
    minHandled: 20,
    /** Default weights (Σ = 1). Presets: support / sales / call_center. */
    weights: {
      occupancy: 0.2,
      availability: 0.15,
      handled: 0.2,
      aht: 0.15,
      sla: 0.15,
      csat: 0.15,
    },
  },
};

// Omni Auto-Reassignment defaults

const DEFAULT_OMNI_CAPACITY = {
  version: 1,
  capacityWeights: {
    voice: 5,
    phone: 5,
    video: 5,
    email: 2,
    whatsapp: 1,
    livechat: 1,
    facebook: 1,
    instagram: 1,
    telegram: 1,
    zalo: 1,
    tiktok: 1,
  },
  afterContactWorkSeconds: {
    voice: 60,
    phone: 60,
    video: 60,
    email: 30,
    whatsapp: 30,
    livechat: 30,
    facebook: 30,
    instagram: 30,
    telegram: 30,
    zalo: 30,
    tiktok: 30,
  },
};

const DEFAULT_OMNI_AUTO_REASSIGNMENT = {
  /** Whether auto-reassignment is enabled when an agent goes offline */
  enabled: false,
  /** Minutes of inactivity/offline before conversations are reassigned */
  timeoutMinutes: 3,
  /** Strategy for reassignment: 'back-to-queue' | 'next-available' | 'supervisor' */
  strategy: 'back-to-queue',
  /** Whether to notify the original agent about reassignment */
  notifyAgent: false,
};

const DEFAULT_OMNI_SESSION_LIFECYCLE = {
  /** Hours after resolve during which a new message reopens the old session */
  reopenWindowHours: 24,
  /** Hours of inactivity (no new messages) after which a session is auto-resolved */
  autoResolveTimeoutHours: 48,
  /** Whether auto-resolve is enabled */
  autoResolveEnabled: true,
  /** Hours before auto-resolve to send a warning message (0 = no warning) */
  autoWarningBeforeResolveHours: 2,
  /** Warning message sent before auto-resolving */
  autoWarningMessage:
    'Are you still there? This conversation will be closed soon if there is no response.',
  /** Whether to send an OOO message when messages arrive outside business hours */
  oooAutoReplyEnabled: false,
  /** The default message text sent when messages arrive outside business hours */
  oooMessage:
    'Thank you for your message! Our team is currently offline. We will get back to you during business hours.',
  /** Channel-specific OOO messages (keyed by lowercase channel type) */
  oooChannelMessages: {} as Record<string, string>,
  /** Whether to set conversation to pending when messages arrive outside business hours */
  oooSetPending: true,
};

// Data Visibility & Sharing Rules

/**
 * Data Visibility configuration.
 *
 * defaultAccess:
 *   - 'private':     Users see only records they own + subordinates' records (role hierarchy).
 *                    Admin/Owner roles bypass this restriction.
 *   - 'public_read': All users can see all records across the tenant (no ownerId filtering).
 */
const DEFAULT_DATA_VISIBILITY = {
  defaultAccess: 'private',
  /**
   * Baseline DataScope for principals whose roles express none. SUBORDINATES
   * preserves the pre-scope contract ("own records plus my reports'"); a tenant
   * that wants strict per-user isolation sets 'self' here, which is the only
   * way a role with dataScope=self actually behaves as self — the two are
   * unioned, so a wide default silently widens narrow roles.
   */
  defaultScope: 'subordinates',
  /** Unowned records (ownerId null) visible to everyone rather than nobody. */
  unownedRecordsVisibleToAll: false,
  /**
   * Whether being named manager of an org unit lets someone see that unit's
   * records, on top of whatever their role scope grants. Default on: naming a
   * manager is already an explicit administrative act, and the alternative
   * (a bespoke role per unit) is what tenants were doing instead.
   */
  managedUnitsEnabled: true,
  /**
   * Per-module overrides of `defaultAccess` / `defaultScope`, keyed by module
   * name ('Contact', 'Deal', …). Absent keys inherit the tenant defaults.
   */
  byModule: {} as Record<
    string,
    { access?: 'private' | 'public_read'; scope?: string }
  >,
};

/**
 * Sharing Rules — the exception mechanism: grant someone visibility of records
 * their scope would not otherwise reach, without changing their role.
 *
 * Each rule specifies:
 *   - sharedFrom:  whose records ('user' / 'group' / 'org_unit' ids, or 'all')
 *   - shareWith:   who gets access ('user' / 'group' / 'role' ids)
 *   - module:      which CRM module, or '*' for every module
 *   - accessLevel: 'read_only' or 'read_write'
 *   - expiresAt:   ISO timestamp; the rule stops applying after it (optional,
 *                  because a temporary cover arrangement that never expires is
 *                  how sharing models rot into everyone-sees-everything)
 */
const DEFAULT_SHARING_RULES = {
  rules: [] as Array<{
    id: string;
    name: string;
    module: string;
    isActive: boolean;
    sharedFrom: { type: 'user' | 'group' | 'org_unit' | 'all'; ids?: string[] };
    shareWith: { type: 'user' | 'group' | 'role'; ids: string[] };
    accessLevel: 'read_only' | 'read_write';
    expiresAt?: string | null;
  }>,
};

const DEFAULT_LIST_VIEWS = {
  views: [
    // Contact column layout views
    // These define WHICH COLUMNS are visible in the table.
    // Labels are resolved by the frontend via i18n (objectManager.fieldLabels.{key}).
    // Filter presets ("All Contacts", "My Open Leads", etc.) are a separate feature
    // managed by the saved views/filters system, NOT here.
    {
      id: 'contact_all_fields',
      name: 'All Fields',
      module: 'Contact',
      createdBy: 'system',
      isSystemDefault: true,
      columns: [
        { key: 'fullName', isVisible: true, sortOrder: 1 },
        { key: 'emails', isVisible: true, sortOrder: 2 },
        { key: 'owner', isVisible: true, sortOrder: 3 },
        { key: 'lifecycleStage', isVisible: true, sortOrder: 4 },
        { key: 'status', isVisible: true, sortOrder: 5 },
        { key: 'companyName', isVisible: true, sortOrder: 6 },
        { key: 'source', isVisible: true, sortOrder: 7 },
        { key: 'title', isVisible: true, sortOrder: 8 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },
    {
      id: 'contact_compact',
      name: 'Compact',
      module: 'Contact',
      createdBy: 'system',
      isSystemDefault: false,
      columns: [
        { key: 'fullName', isVisible: true, sortOrder: 1 },
        { key: 'emails', isVisible: true, sortOrder: 2 },
        { key: 'owner', isVisible: true, sortOrder: 3 },
        { key: 'lifecycleStage', isVisible: true, sortOrder: 4 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },

    // Account column layout views
    {
      id: 'account_all_fields',
      name: 'All Fields',
      module: 'Account',
      createdBy: 'system',
      isSystemDefault: true,
      columns: [
        { key: 'name', isVisible: true, sortOrder: 1 },
        { key: 'industry', isVisible: true, sortOrder: 2 },
        { key: 'website', isVisible: true, sortOrder: 3 },
        { key: 'owner', isVisible: true, sortOrder: 4 },
        { key: 'status', isVisible: true, sortOrder: 5 },
        { key: 'phones', isVisible: true, sortOrder: 6 },
        { key: 'emails', isVisible: true, sortOrder: 7 },
        { key: 'annualRevenue', isVisible: true, sortOrder: 8 },
        { key: 'employees', isVisible: true, sortOrder: 9 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },
    {
      id: 'account_compact',
      name: 'Compact',
      module: 'Account',
      createdBy: 'system',
      isSystemDefault: false,
      columns: [
        { key: 'name', isVisible: true, sortOrder: 1 },
        { key: 'industry', isVisible: true, sortOrder: 2 },
        { key: 'owner', isVisible: true, sortOrder: 3 },
        { key: 'status', isVisible: true, sortOrder: 4 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },

    // Ticket column layout views
    {
      id: 'ticket_all_fields',
      name: 'All Fields',
      module: 'Ticket',
      createdBy: 'system',
      isSystemDefault: true,
      columns: [
        { key: 'ticketNumber', isVisible: true, sortOrder: 1 },
        { key: 'subject', isVisible: true, sortOrder: 2 },
        { key: 'contact', isVisible: true, sortOrder: 3 },
        { key: 'owner', isVisible: true, sortOrder: 4 },
        { key: 'priority', isVisible: true, sortOrder: 5 },
        { key: 'status', isVisible: true, sortOrder: 6 },
        { key: 'createdAt', isVisible: true, sortOrder: 7 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },
    {
      id: 'ticket_compact',
      name: 'Compact',
      module: 'Ticket',
      createdBy: 'system',
      isSystemDefault: false,
      columns: [
        { key: 'ticketNumber', isVisible: true, sortOrder: 1 },
        { key: 'subject', isVisible: true, sortOrder: 2 },
        { key: 'priority', isVisible: true, sortOrder: 3 },
        { key: 'status', isVisible: true, sortOrder: 4 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },

    // Deal column layout views
    {
      id: 'deal_all_fields',
      name: 'All Fields',
      module: 'Deal',
      createdBy: 'system',
      isSystemDefault: true,
      columns: [
        { key: 'title', isVisible: true, sortOrder: 1 },
        { key: 'accountName', isVisible: true, sortOrder: 2 },
        { key: 'value', isVisible: true, sortOrder: 3 },
        { key: 'owner', isVisible: true, sortOrder: 4 },
        { key: 'stage', isVisible: true, sortOrder: 5 },
        { key: 'probability', isVisible: true, sortOrder: 6 },
        { key: 'closeDate', isVisible: true, sortOrder: 7 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },
    {
      id: 'deal_compact',
      name: 'Compact',
      module: 'Deal',
      createdBy: 'system',
      isSystemDefault: false,
      columns: [
        { key: 'title', isVisible: true, sortOrder: 1 },
        { key: 'value', isVisible: true, sortOrder: 2 },
        { key: 'stage', isVisible: true, sortOrder: 3 },
        { key: 'closeDate', isVisible: true, sortOrder: 4 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },

    // Task column layout views
    {
      id: 'task_all_fields',
      name: 'All Fields',
      module: 'Task',
      createdBy: 'system',
      isSystemDefault: true,
      columns: [
        { key: 'title', isVisible: true, sortOrder: 1 },
        { key: 'category', isVisible: true, sortOrder: 2 },
        { key: 'status', isVisible: true, sortOrder: 3 },
        { key: 'priority', isVisible: true, sortOrder: 4 },
        { key: 'owner', isVisible: true, sortOrder: 5 },
        { key: 'dueDate', isVisible: true, sortOrder: 6 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },
    {
      id: 'task_compact',
      name: 'Compact',
      module: 'Task',
      createdBy: 'system',
      isSystemDefault: false,
      columns: [
        { key: 'title', isVisible: true, sortOrder: 1 },
        { key: 'status', isVisible: true, sortOrder: 2 },
        { key: 'priority', isVisible: true, sortOrder: 3 },
        { key: 'dueDate', isVisible: true, sortOrder: 4 },
      ],
      assignedGroupIds: [],
      excludedUserIds: [],
    },
  ],
};

// Navigation / Workspaces

/**
 * Workspaces — the named groupings behind the sidebar switcher.
 *
 * Per tenant, not hard-coded, because "which menus does a salesperson see" is a
 * question every company answers differently. The five fixed labels this
 * replaced (sales/service/marketing/operations/admin) were the same for every
 * tenant and could not be renamed, reordered, hidden, or added to.
 *
 * This is NAVIGATION, not security. `requires` decides whether a workspace is
 * offered in the switcher; it never decides whether a route is reachable — the
 * route guards and the API do, and they are unaffected by anything stored here.
 *
 * `requires` values:
 *   null                    — everyone
 *   'owner'                 — the tenant owner only (tenant.ownerId)
 *   'permission:<key>'      — holders of that permission key
 *
 * The seeded three answer "where does someone land on first login": the first
 * workspace in `order` they are allowed to see. Owner → Owner, an admin →
 * Admin, everyone else → Member. Tenants rename, hide, reorder and add their
 * own from Settings; nothing below is privileged over a tenant's own entries.
 */
const DEFAULT_NAVIGATION_WORKSPACES = {
  workspaces: [
    {
      id: 'owner',
      label: 'Owner',
      color: 'bg-amber-500',
      order: 10,
      hidden: false,
      requires: 'owner',
    },
    {
      id: 'admin',
      label: 'Admin',
      color: 'bg-slate-500',
      order: 20,
      hidden: false,
      requires: 'permission:settings:view',
    },
    {
      id: 'member',
      label: 'Member',
      color: 'bg-emerald-500',
      order: 30,
      hidden: false,
      requires: null,
    },
  ] as Array<{
    id: string;
    label: string;
    color: string;
    order: number;
    hidden: boolean;
    requires: string | null;
  }>,
  /**
   * Which workspaces each navigation item appears in.
   *
   * **Owner holds every item.** The owner is the one person who is accountable
   * for the whole workspace, and a curated "oversight" menu meant they had to
   * switch workspaces to reach the modules they own. A menu that hides things
   * from the person responsible for them is a worse default than a long one;
   * they can shorten it from Settings, which is the point of this being
   * per-tenant.
   *
   * Admin and Member stay split by JOB rather than by permission — an owner and
   * an admin hold identical keys, so grouping by permission would produce two
   * identical menus. The admin's day is running the system; the member's is the
   * work itself.
   *
   * An id absent from this list is hidden everywhere, which is how a tenant
   * removes an item without it reappearing on the next release.
   */
  items: [
    {
      itemId: 'dashboard',
      workspaces: ['owner', 'admin', 'member'],
      order: 10,
    },
    {
      itemId: 'omni_channel',
      workspaces: ['owner', 'admin', 'member'],
      order: 20,
    },
    {
      itemId: 'contacts',
      workspaces: ['owner', 'admin', 'member'],
      order: 30,
    },
    {
      itemId: 'accounts',
      workspaces: ['owner', 'admin', 'member'],
      order: 40,
    },
    { itemId: 'deals', workspaces: ['owner', 'admin', 'member'], order: 50 },
    { itemId: 'tickets', workspaces: ['owner', 'admin', 'member'], order: 60 },
    { itemId: 'tasks', workspaces: ['owner', 'admin', 'member'], order: 70 },
    { itemId: 'campaigns', workspaces: ['owner', 'admin'], order: 80 },
    { itemId: 'social_posts', workspaces: ['owner', 'admin'], order: 90 },
    { itemId: 'ai_video', workspaces: ['owner', 'admin'], order: 100 },
    { itemId: 'reports', workspaces: ['owner', 'admin'], order: 110 },
    { itemId: 'omni_reports', workspaces: ['owner', 'admin'], order: 120 },
    { itemId: 'agent_leaderboard', workspaces: ['owner', 'admin'], order: 130 },
    { itemId: 'revenue_forecast', workspaces: ['owner'], order: 140 },
    { itemId: 'dashboards', workspaces: ['owner', 'admin'], order: 150 },
    { itemId: 'settings', workspaces: ['owner', 'admin'], order: 160 },
  ] as Array<{ itemId: string; workspaces: string[]; order: number }>,
};

/** Lookup map used by lazySeed() and getDefault(). Add new keys here when a new module ships. */
export const DEFAULTS_MAP: Record<string, unknown> = {
  navigation_workspaces: DEFAULT_NAVIGATION_WORKSPACES,
  contact_identity: DEFAULT_CONTACT_IDENTITY,
  contact_relationship: DEFAULT_CONTACT_RELATIONSHIP,
  contact_communication: DEFAULT_CONTACT_COMMUNICATION,
  contact_roles: DEFAULT_CONTACT_ROLES,
  contact_assignment: DEFAULT_CONTACT_ASSIGNMENT,
  contact_conversion: DEFAULT_CONTACT_CONVERSION,
  contact_source: DEFAULT_CONTACT_SOURCE,
  account_source: DEFAULT_ACCOUNT_SOURCE,
  deal_source: DEFAULT_DEAL_SOURCE,
  ticket_source: DEFAULT_TICKET_SOURCE,
  ticket_type: DEFAULT_TICKET_TYPE,
  ticket_category: DEFAULT_TICKET_CATEGORY,
  ticket_resolution: DEFAULT_TICKET_RESOLUTION,
  task_source: DEFAULT_TASK_SOURCE,
  contact_lifecycle: DEFAULT_CONTACT_LIFECYCLE,
  account_lifecycle: DEFAULT_ACCOUNT_LIFECYCLE,
  ticket_lifecycle: DEFAULT_TICKET_LIFECYCLE,
  task_lifecycle: DEFAULT_TASK_LIFECYCLE,
  [DEAL_RULES_SETTING_KEY]: DEFAULT_DEAL_RULES,
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
  general_profile: DEFAULT_GENERAL_PROFILE,
  general_localization: DEFAULT_GENERAL_LOCALIZATION,
  general_notifications: DEFAULT_GENERAL_NOTIFICATIONS,
  omni_routing: DEFAULT_OMNI_ROUTING,
  omni_presence: DEFAULT_OMNI_PRESENCE,
  omni_capacity: DEFAULT_OMNI_CAPACITY,
  omni_auto_reassignment: DEFAULT_OMNI_AUTO_REASSIGNMENT,
  omni_session_lifecycle: DEFAULT_OMNI_SESSION_LIFECYCLE,
  omni_identity_resolution: DEFAULT_OMNI_IDENTITY_RESOLUTION,
  data_visibility: DEFAULT_DATA_VISIBILITY,
  sharing_rules: DEFAULT_SHARING_RULES,
  list_views: DEFAULT_LIST_VIEWS,
  email_settings: DEFAULT_EMAIL_SETTINGS,
};
