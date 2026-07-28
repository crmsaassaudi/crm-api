/**
 * The record families a tenant can configure data visibility for separately.
 *
 * One list, referenced by the repositories (which tag their rows), the settings
 * DTO (which validates what an admin may configure) and the interceptor (which
 * precomputes a scope per module). Keeping it in one place is what stops a
 * settings page from offering a module the enforcement layer silently ignores —
 * the failure mode the previous sharing-rules UI shipped with.
 *
 * Values are the human-facing singular names already used by the sharing-rules
 * settings and the web module pickers, so existing stored settings keep
 * resolving.
 */
export const VISIBILITY_MODULES = [
  'Contact',
  'Account',
  'Deal',
  'Ticket',
  'Task',
  'Conversation',
] as const;

export type VisibilityModule = (typeof VISIBILITY_MODULES)[number];

export const isVisibilityModule = (value: unknown): value is VisibilityModule =>
  typeof value === 'string' &&
  (VISIBILITY_MODULES as readonly string[]).includes(value);
