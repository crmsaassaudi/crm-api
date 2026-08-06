import { COLLECTIONS } from './collections';
import { AccountStatusSchema } from '../../account-settings/entities/account-status.schema';
import { AccountTypeSchema } from '../../account-settings/entities/account-type.schema';
import { DealSourceSchema } from '../../deal-settings/entities/deal-source.schema';
import { DealStageSchema } from '../../deal-settings/entities/deal-stage.schema';
import { TicketSchema } from '../../tickets/infrastructure/persistence/document/entities/ticket.schema';
import { TicketMessageSchema } from '../../tickets/infrastructure/persistence/document/entities/ticket-message.schema';
import { TicketResolutionCodeSchema } from '../../ticket-settings/entities/ticket-resolution-code.schema';
import { TicketSourceSchema } from '../../ticket-settings/entities/ticket-source.schema';
import { TicketStatusSchema } from '../../ticket-settings/entities/ticket-status.schema';
import { TicketTypeSchema } from '../../ticket-settings/entities/ticket-type.schema';
import { SlaPolicySchema } from '../../sla-policies/infrastructure/persistence/document/entities/sla-policy.schema';

/**
 * The drift guard described in `collections.ts`.
 *
 * A `$lookup` or raw-driver read against a misspelled collection does not throw
 * — it returns nothing — so the only place this class of bug can be caught is
 * here, by comparing the constant against the schema that owns the collection.
 */
describe('COLLECTIONS', () => {
  const owners: Array<[string, { get(option: string): unknown }]> = [
    [COLLECTIONS.accountStatuses, AccountStatusSchema],
    [COLLECTIONS.accountTypes, AccountTypeSchema],
    [COLLECTIONS.dealSources, DealSourceSchema],
    [COLLECTIONS.dealStages, DealStageSchema],
    [COLLECTIONS.slaPolicies, SlaPolicySchema],
    [COLLECTIONS.tickets, TicketSchema],
    [COLLECTIONS.ticketMessages, TicketMessageSchema],
    [COLLECTIONS.ticketResolutionCodes, TicketResolutionCodeSchema],
    [COLLECTIONS.ticketSources, TicketSourceSchema],
    [COLLECTIONS.ticketStatuses, TicketStatusSchema],
    [COLLECTIONS.ticketTypes, TicketTypeSchema],
  ];

  it.each(owners)('%s matches its schema collection option', (name, schema) => {
    expect(schema.get('collection')).toBe(name);
  });

  it('should have no duplicate physical names', () => {
    const values = Object.values(COLLECTIONS);
    expect(new Set(values).size).toBe(values.length);
  });
});
