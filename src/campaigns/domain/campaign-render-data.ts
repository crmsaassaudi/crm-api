/**
 * Builds the data bag `TemplateVariableRegistryService.render()` resolves
 * `{{contact.firstName}}`-style tokens against for a campaign recipient.
 *
 * Replaces the old `personalise.ts`'s flat 4-token whitelist (`{{firstName}}`)
 * with the same `contact.*`/`organization.*` namespace every other template
 * surface (agent replies, automation, bot) uses — one variable vocabulary
 * instead of a campaign-only dialect.
 */
export interface CampaignContactFields {
  firstName?: string;
  lastName?: string;
  companyName?: string;
}

export function buildCampaignRenderData(
  contact: CampaignContactFields,
): Record<string, Record<string, string>> {
  const firstName = (contact.firstName ?? '').trim();
  const lastName = (contact.lastName ?? '').trim();
  return {
    contact: {
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' '),
    },
    organization: {
      name: (contact.companyName ?? '').trim(),
    },
  };
}
