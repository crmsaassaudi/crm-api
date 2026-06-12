import { Ticket } from '../../tickets/domain/ticket';

let counter = 0;

export function createTicket(overrides: Partial<Ticket> = {}): Ticket {
  counter++;
  const id = overrides.id ?? `ticket_${counter}`;
  return {
    id,
    tenantId: 'tenant_1',
    ticketNumber: `TKT-${String(counter).padStart(5, '0')}`,
    subject: 'Test ticket subject',
    description: 'Test ticket description',
    typeId: 'type_default',
    priority: 'MEDIUM',
    statusId: 'status_open',
    isSlaBreached: false,
    timeSpentSeconds: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createTicketDto(overrides: Record<string, any> = {}) {
  return {
    subject: 'New ticket',
    description: 'Ticket description',
    typeId: 'type_default',
    priority: 'MEDIUM',
    ...overrides,
  };
}
