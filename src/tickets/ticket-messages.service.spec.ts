import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TicketMessagesService } from './ticket-messages.service';
import { TicketEvents } from './domain/ticket-events';

const execQuery = (value: any) => ({
  exec: jest.fn().mockResolvedValue(value),
});

/** `findOne(...).select(...).lean().exec()` */
const selectLean = (value: any) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn(() => execQuery(value)) }),
});

describe('TicketMessagesService', () => {
  let messages: any;
  let tickets: any;
  let files: any;
  let events: any;
  let entityAudit: any;
  let service: TicketMessagesService;

  const LIVE_TICKET = { _id: 'ticket_1', firstRespondedAt: null };

  beforeEach(() => {
    messages = {
      create: jest.fn().mockResolvedValue({
        _id: 'msg_1',
        createdAt: new Date('2026-08-07T09:00:00.000Z'),
      }),
      find: jest.fn(),
      findOne: jest.fn(),
      findById: jest.fn(() => ({
        populate: jest.fn().mockReturnValue({
          lean: jest.fn(() =>
            execQuery({
              _id: 'msg_1',
              kind: 'reply',
              authorType: 'agent',
              authorId: 'user_1',
              body: 'Refunded.',
              attachmentIds: [],
              createdAt: new Date(),
            }),
          ),
        }),
      })),
    };
    tickets = {
      findOne: jest.fn(() => selectLean(LIVE_TICKET)),
      updateOne: jest.fn(() => execQuery({ modifiedCount: 1 })),
    };
    files = {
      find: jest.fn(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn(() => execQuery([])) }),
      })),
      countDocuments: jest.fn(() => execQuery(0)),
    };
    events = { emit: jest.fn() };
    entityAudit = { emit: jest.fn() };

    const cls = {
      get: jest.fn((key: string) =>
        key === 'userId'
          ? 'user_1'
          : key === 'tenantId'
            ? 'tenant_1'
            : undefined,
      ),
    };

    service = new TicketMessagesService(
      messages,
      tickets,
      files,
      cls as any,
      events,
      entityAudit,
    );
  });

  describe('create', () => {
    it('should refuse to post onto a ticket that is gone', async () => {
      tickets.findOne.mockReturnValue(selectLean(null));

      await expect(
        service.create('ticket_1', { kind: 'reply', body: 'hi' }),
      ).rejects.toThrow(NotFoundException);
      expect(messages.create).not.toHaveBeenCalled();
    });

    /**
     * The first-response SLA is measured against a customer-visible reply. An
     * internal note must never mark the customer as answered — that is the
     * whole reason the two are different kinds.
     */
    it('should stamp first response and emit REPLIED for a public reply', async () => {
      await service.create('ticket_1', { kind: 'reply', body: 'Refunded.' });

      expect(tickets.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'ticket_1', firstRespondedAt: null }),
        {
          $set: {
            firstRespondedAt: expect.any(Date),
            firstRespondedById: 'user_1',
          },
        },
      );
      expect(events.emit).toHaveBeenCalledWith(
        TicketEvents.REPLIED,
        expect.objectContaining({ ticketId: 'ticket_1', authorId: 'user_1' }),
      );
    });

    it('should not touch first response for an internal note', async () => {
      await service.create('ticket_1', {
        kind: 'note',
        body: 'Watch this one',
      });

      expect(tickets.updateOne).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalledWith(
        TicketEvents.REPLIED,
        expect.anything(),
      );
    });

    /**
     * The stamp is conditional on the field still being null, in one atomic
     * write: two agents replying at the same moment must not push the recorded
     * first response later and later.
     */
    it('should emit FIRST_RESPONDED only when the stamp actually landed', async () => {
      tickets.updateOne.mockReturnValue(execQuery({ modifiedCount: 0 }));

      await service.create('ticket_1', { kind: 'reply', body: 'second reply' });

      expect(events.emit).not.toHaveBeenCalledWith(
        TicketEvents.FIRST_RESPONDED,
        expect.anything(),
      );
      // The reply itself still counts — a later turn owes a next_response.
      expect(events.emit).toHaveBeenCalledWith(
        TicketEvents.REPLIED,
        expect.anything(),
      );
    });

    it('should refuse attachments that are not this tenant’s', async () => {
      files.countDocuments.mockReturnValue(execQuery(1));

      await expect(
        service.create('ticket_1', {
          kind: 'reply',
          body: 'see attached',
          attachmentIds: [
            '60d0fe4f5311236168a109ca',
            '60d0fe4f5311236168a109cb',
          ],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(messages.create).not.toHaveBeenCalled();
    });
  });

  describe('editing', () => {
    const ownedNote = (overrides: Record<string, unknown> = {}): any => ({
      _id: 'msg_1',
      kind: 'note',
      authorId: 'user_1',
      body: 'old',
      save: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    it('should refuse to edit someone else’s entry', async () => {
      messages.findOne.mockReturnValue(
        execQuery(ownedNote({ authorId: 'user_2' })),
      );

      await expect(
        service.update('ticket_1', 'msg_1', { body: 'rewritten' }),
      ).rejects.toThrow(ForbiddenException);
    });

    /**
     * The timeline is what an audit reads back. Letting anyone rewrite what the
     * platform recorded would make it useless as evidence.
     */
    it('should refuse to edit a system entry', async () => {
      messages.findOne.mockReturnValue(
        execQuery(ownedNote({ kind: 'system' })),
      );

      await expect(
        service.update('ticket_1', 'msg_1', { body: 'rewritten' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should soft-delete rather than remove, keeping the audit trail', async () => {
      const note = ownedNote();
      messages.findOne.mockReturnValue(execQuery(note));

      await service.remove('ticket_1', 'msg_1');

      expect(note.deletedAt).toEqual(expect.any(Date));
      expect(note.save).toHaveBeenCalled();
    });
  });

  describe('appendSystem', () => {
    /**
     * The timeline narrates a change that has already committed, so failing to
     * narrate it must not fail the change. A missing line is recoverable; a
     * rolled-back status transition is not.
     */
    it('should swallow a write failure', async () => {
      messages.create.mockRejectedValue(new Error('mongo down'));

      await expect(
        service.appendSystem({
          tenantId: 'tenant_1',
          ticketId: 'ticket_1',
          body: 'Status changed',
        }),
      ).resolves.toBeUndefined();
    });
  });
});
