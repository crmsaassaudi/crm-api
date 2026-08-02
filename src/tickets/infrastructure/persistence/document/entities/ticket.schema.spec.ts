import 'reflect-metadata';
import { TicketSchema } from './ticket.schema';

describe('TicketSchema indexes', () => {
  it('should scope ticket-number uniqueness to the tenant', () => {
    const indexes = TicketSchema.indexes();
    expect(indexes).toContainEqual([
      { tenantId: 1, ticketNumber: 1 },
      expect.objectContaining({
        unique: true,
        name: 'tenant_ticket_number_unique',
      }),
    ]);

    const ticketNumberPath = TicketSchema.path('ticketNumber') as any;
    expect(ticketNumberPath.options.unique).not.toBe(true);
  });

  it('should index deal, hierarchy, and recycle-bin query shapes', () => {
    const names = TicketSchema.indexes().map(([, options]) => options.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'tenant_deal_created_lookup',
        'tenant_parent_created_lookup',
        'tenant_recycle_bin',
      ]),
    );
  });
});
