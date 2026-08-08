import { TemplatePurpose } from './message-template';

export interface TemplateVariableDefinition {
  /** Dot-path resolved against the render data bag, e.g. "contact.firstName". */
  path: string;
  labels: { vi: string; en: string; ar: string };
  sampleValue: string;
  /** Which template purposes may reference this token in strict mode. */
  availableIn: TemplatePurpose[];
}

/**
 * The whitelist for strict-mode rendering (agent_reply / campaign / bot).
 *
 * Kept intentionally small — this is a security boundary (personalise.ts's
 * whitelist), not a field browser. Automation keeps its own broader,
 * per-module field set (see TemplateVariableRegistryService's `broad` mode)
 * because narrowing it would risk breaking workflows already live in
 * production; only the strict-mode consumers are gated by this list.
 */
export const TEMPLATE_VARIABLE_DEFINITIONS: TemplateVariableDefinition[] = [
  {
    path: 'contact.firstName',
    labels: { vi: 'Tên', en: 'First name', ar: 'الاسم الأول' },
    sampleValue: 'Sara',
    availableIn: ['agent_reply', 'campaign', 'bot'],
  },
  {
    path: 'contact.lastName',
    labels: { vi: 'Họ', en: 'Last name', ar: 'اسم العائلة' },
    sampleValue: 'Ahmed',
    availableIn: ['agent_reply', 'campaign', 'bot'],
  },
  {
    path: 'contact.fullName',
    labels: { vi: 'Họ và tên', en: 'Full name', ar: 'الاسم الكامل' },
    sampleValue: 'Sara Ahmed',
    availableIn: ['agent_reply', 'campaign', 'bot'],
  },
  {
    path: 'contact.phone',
    labels: { vi: 'Số điện thoại', en: 'Phone', ar: 'رقم الهاتف' },
    sampleValue: '+966501234567',
    availableIn: ['agent_reply', 'bot'],
  },
  {
    path: 'contact.email',
    labels: { vi: 'Email', en: 'Email', ar: 'البريد الإلكتروني' },
    sampleValue: 'sara@example.com',
    availableIn: ['agent_reply', 'campaign', 'bot'],
  },
  {
    path: 'organization.name',
    labels: { vi: 'Tên công ty', en: 'Company name', ar: 'اسم الشركة' },
    sampleValue: 'Northwind Trading',
    availableIn: ['agent_reply', 'campaign', 'bot'],
  },
  {
    path: 'deal.title',
    labels: { vi: 'Tên thương vụ', en: 'Deal title', ar: 'عنوان الصفقة' },
    sampleValue: 'Website revamp',
    availableIn: ['agent_reply', 'bot'],
  },
  {
    path: 'deal.value',
    labels: { vi: 'Giá trị thương vụ', en: 'Deal value', ar: 'قيمة الصفقة' },
    sampleValue: '25,000',
    availableIn: ['agent_reply', 'bot'],
  },
  {
    path: 'ticket.ticketNumber',
    labels: { vi: 'Mã ticket', en: 'Ticket number', ar: 'رقم التذكرة' },
    sampleValue: 'TCK-00042',
    availableIn: ['agent_reply', 'bot'],
  },
  {
    path: 'ticket.subject',
    labels: { vi: 'Tiêu đề ticket', en: 'Ticket subject', ar: 'موضوع التذكرة' },
    sampleValue: 'Cannot log in',
    availableIn: ['agent_reply', 'bot'],
  },
  {
    path: 'agent.name',
    labels: { vi: 'Tên nhân viên', en: 'Agent name', ar: 'اسم الموظف' },
    sampleValue: 'Yen',
    availableIn: ['agent_reply', 'campaign', 'bot'],
  },
  {
    path: 'tenant.name',
    labels: { vi: 'Tên doanh nghiệp', en: 'Business name', ar: 'اسم الشركة' },
    sampleValue: 'CRM Saudi',
    availableIn: ['agent_reply', 'campaign', 'bot'],
  },
];

export function variablesForPurpose(
  purpose: TemplatePurpose,
): TemplateVariableDefinition[] {
  return TEMPLATE_VARIABLE_DEFINITIONS.filter((v) =>
    v.availableIn.includes(purpose),
  );
}

export function isKnownStrictPath(
  path: string,
  purpose: TemplatePurpose,
): boolean {
  return variablesForPurpose(purpose).some((v) => v.path === path);
}
