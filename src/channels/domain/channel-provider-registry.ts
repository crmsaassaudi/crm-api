/**
 * Channel Provider Registry — Static TypeScript Schema Definitions
 *
 * Each provider declares its credential fields (encrypted) and public setting fields.
 * Frontend calls GET /channel-providers/schemas and auto-renders forms from this data.
 *
 * To add a new provider:
 *   1. Create an adapter in /channels/adapters/
 *   2. Add a ProviderSchema entry to PROVIDER_REGISTRY below
 *   3. Deploy — Frontend auto-renders the new form. Zero UI code changes needed.
 */

// ── Field Schema ──────────────────────────────────────────────────────────

export interface ProviderFieldSchema {
  /** Unique key within the provider (e.g. 'apiKey', 'fromEmail') */
  key: string;

  /** Input type for frontend rendering */
  type: 'text' | 'password' | 'email' | 'checkbox';

  /** Human-readable label (English default; i18n handled by frontend) */
  label: string;

  /** Whether the field is required for validation */
  required: boolean;

  /** Placeholder text */
  placeholder?: string;

  /** Help text displayed below the input */
  helpText?: string;

  /** Default value for the field when creating a new config */
  defaultValue?: string | boolean | number;
}

// ── Provider Schema ───────────────────────────────────────────────────────

export interface ProviderSchema {
  /** Unique identifier (e.g. 'sendgrid', 'twilio') */
  providerType: string;

  /** Schema version for migration-on-read and provider evolution */
  schemaVersion: number;

  /** Display name */
  label: string;

  /** Icon identifier for frontend (lucide icon names) */
  icon: string;

  /** Channel category */
  category: 'email' | 'sms';

  /** Fields stored encrypted (API keys, tokens) */
  credentialFields: ProviderFieldSchema[];

  /** Fields stored in plaintext (fromEmail, fromName, etc.) */
  settingFields: ProviderFieldSchema[];
}

// ── Registry ──────────────────────────────────────────────────────────────

export const PROVIDER_REGISTRY: ProviderSchema[] = [
  {
    providerType: 'sendgrid',
    schemaVersion: 1,
    label: 'SendGrid',
    icon: 'mail',
    category: 'email',
    credentialFields: [
      {
        key: 'apiKey',
        type: 'password',
        label: 'API Key',
        required: true,
        placeholder: 'SG.xxxx...',
        helpText: 'Found in SendGrid → Settings → API Keys',
      },
    ],
    settingFields: [
      {
        key: 'fromEmail',
        type: 'email',
        label: 'From Email',
        required: true,
        placeholder: 'noreply@yourdomain.com',
        helpText: 'Must be a verified sender in SendGrid',
      },
      {
        key: 'fromName',
        type: 'text',
        label: 'From Name',
        required: true,
        placeholder: 'My Company',
      },
    ],
  },
  {
    providerType: 'smtp',
    schemaVersion: 2,
    label: 'Email (SMTP)',
    icon: 'mail',
    category: 'email',
    credentialFields: [
      {
        key: 'user',
        type: 'text',
        label: 'Email / Username',
        required: true,
        placeholder: 'you@gmail.com',
        helpText: 'Your email address or SMTP username',
      },
      {
        key: 'password',
        type: 'password',
        label: 'App Password',
        required: true,
        placeholder: '••••••••••••••••',
        helpText:
          'Gmail: Create an App Password at myaccount.google.com/apppasswords',
      },
    ],
    settingFields: [
      {
        key: 'host',
        type: 'text',
        label: 'SMTP Host',
        required: true,
        placeholder: 'smtp.gmail.com',
        helpText: 'Gmail: smtp.gmail.com / Outlook: smtp.office365.com',
      },
      {
        key: 'port',
        type: 'text',
        label: 'SMTP Port',
        required: true,
        placeholder: '587',
        helpText: '587 (STARTTLS) or 465 (SSL)',
      },
      {
        key: 'fromEmail',
        type: 'email',
        label: 'From Email',
        required: true,
        placeholder: 'you@gmail.com',
      },
      {
        key: 'fromName',
        type: 'text',
        label: 'From Name',
        required: false,
        placeholder: 'My Company',
      },
      {
        key: 'imapHost',
        type: 'text',
        label: 'IMAP Host (Inbound Sync)',
        required: false,
        placeholder: 'imap.gmail.com',
        helpText: 'Leave empty to disable email inbound sync',
      },
      {
        key: 'imapPort',
        type: 'text',
        label: 'IMAP Port',
        required: false,
        placeholder: '993',
        helpText: '993 (SSL) or 143 (STARTTLS)',
      },
      {
        key: 'syncReadState',
        type: 'checkbox',
        label: 'Sync Read Status (Two-way sync)',
        required: false,
        helpText:
          'Sync read status back to email provider (Gmail/Outlook). Enabled by default.',
        defaultValue: true,
      },
      {
        key: 'initialSyncDays',
        type: 'text',
        label: 'Initial Sync Window (Days)',
        required: false,
        placeholder: '30',
        helpText:
          'Number of days to look back for emails during the first synchronization',
        defaultValue: '30',
      },
      {
        key: 'blockAutoResponders',
        type: 'checkbox',
        label: 'Block Auto-Responders',
        required: false,
        helpText:
          'Filter out and drop auto-responders/system-generated emails. Disabled by default (syncs all).',
        defaultValue: false,
      },
    ],
  },
  {
    providerType: 'twilio',
    schemaVersion: 1,
    label: 'Twilio',
    icon: 'phone',
    category: 'sms',
    credentialFields: [
      {
        key: 'accountSid',
        type: 'text',
        label: 'Account SID',
        required: true,
        placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        helpText: 'Found in Twilio Console → Dashboard',
      },
      {
        key: 'authToken',
        type: 'password',
        label: 'Auth Token',
        required: true,
        placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      },
    ],
    settingFields: [
      {
        key: 'fromNumber',
        type: 'text',
        label: 'From Number',
        required: true,
        placeholder: '+84xxxxxxxxx',
        helpText: 'E.164 format. Must be a Twilio-owned number.',
      },
    ],
  },
];

/**
 * Lookup a provider schema by type.
 */
export function getProviderSchema(
  providerType: string,
): ProviderSchema | undefined {
  return PROVIDER_REGISTRY.find((p) => p.providerType === providerType);
}
