import { Contact } from '../../contacts/domain/contact';

let counter = 0;

/**
 * Build a Contact domain object with sensible defaults.
 * Every call returns a unique id to avoid collisions.
 */
export function createContact(overrides: Partial<Contact> = {}): Contact {
  counter++;
  const id = overrides.id ?? `contact_${counter}`;
  return {
    id,
    tenantId: 'tenant_1',
    firstName: 'John',
    lastName: 'Doe',
    emails: ['john@example.com'],
    phones: ['+15551234567'],

    lifecycleStageId: 'lead',
    statusId: 'new',
    createdById: 'user_1',
    updatedById: 'user_1',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Build a minimal CreateContactDto-like payload.
 */
export function createContactDto(overrides: Record<string, any> = {}) {
  return {
    firstName: 'Jane',
    lastName: 'Smith',
    emails: ['jane@example.com'],
    phones: ['+15559876543'],
    ...overrides,
  };
}
