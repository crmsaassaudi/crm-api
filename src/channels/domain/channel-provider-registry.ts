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
  type: 'text' | 'password' | 'email';

  /** Human-readable label (English default; i18n handled by frontend) */
  label: string;

  /** Whether the field is required for validation */
  required: boolean;

  /** Placeholder text */
  placeholder?: string;

  /** Help text displayed below the input */
  helpText?: string;
}

// ── Provider Schema ───────────────────────────────────────────────────────

export interface ProviderSchema {
  /** Unique identifier (e.g. 'sendgrid', 'twilio') */
  providerType: string;

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
    providerType: 'twilio',
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
