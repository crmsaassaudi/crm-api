import { ClsServiceManager } from 'nestjs-cls';
import { TicketConversationReplyListener } from './ticket-conversation-reply.listener';
import { TicketEvents } from '../domain/ticket-events';

describe('TicketConversationReplyListener', () => {
  const tenantId = 'tenant_1';
  const conversationId = 'conv_1';

  function build(linkedTickets: Array<{ id: string }>) {
    const tickets: any = { find: jest.fn().mockResolvedValue(linkedTickets) };
    const events: any = { emit: jest.fn() };
    const cls = ClsServiceManager.getClsService();
    const listener = new TicketConversationReplyListener(tickets, events, cls);
    return { listener, tickets, events };
  }

  it('emits CUSTOMER_REPLIED for every open ticket linked to the conversation', async () => {
    const { listener, tickets, events } = build([
      { id: 'ticket_1' },
      { id: 'ticket_2' },
    ]);

    await listener.onMessagePersisted({
      tenantId,
      conversationId,
      senderType: 'customer',
      internalMessageId: 'msg_1',
    });

    expect(tickets.find).toHaveBeenCalledWith({
      omniConversationId: conversationId,
      deletedAt: null,
      closedAt: null,
    });
    expect(events.emit).toHaveBeenCalledTimes(2);
    expect(events.emit).toHaveBeenCalledWith(
      TicketEvents.CUSTOMER_REPLIED,
      expect.objectContaining({ tenantId, ticketId: 'ticket_1' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      TicketEvents.CUSTOMER_REPLIED,
      expect.objectContaining({ tenantId, ticketId: 'ticket_2' }),
    );
  });

  it('ignores messages sent by an agent, not a customer', async () => {
    const { listener, tickets, events } = build([{ id: 'ticket_1' }]);

    await listener.onMessagePersisted({
      tenantId,
      conversationId,
      senderType: 'agent',
    });

    expect(tickets.find).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does nothing when no ticket is linked to the conversation', async () => {
    const { listener, tickets, events } = build([]);

    await listener.onMessagePersisted({
      tenantId,
      conversationId,
      senderType: 'customer',
    });

    expect(tickets.find).toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
