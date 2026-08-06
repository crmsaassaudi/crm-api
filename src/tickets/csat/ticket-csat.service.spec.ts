import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketCsatService } from './ticket-csat.service';
import type { TicketStatusChangedEvent } from '../domain/ticket-events';

const execQuery = (value: any) => ({
  exec: jest.fn().mockResolvedValue(value),
});
const selectLean = (value: any) => ({
  select: jest.fn().mockReturnValue({
    setOptions: jest
      .fn()
      .mockReturnValue({ lean: jest.fn(() => execQuery(value)) }),
    lean: jest.fn(() => execQuery(value)),
  }),
});

const TOKEN = 'a'.repeat(32);

describe('TicketCsatService', () => {
  let tickets: any;
  let events: any;
  let service: TicketCsatService;

  const resolvedTransition = (
    overrides: Partial<TicketStatusChangedEvent> = {},
  ): TicketStatusChangedEvent => ({
    tenantId: 'tenant_1',
    ticketId: 'ticket_1',
    actorId: 'user_1',
    previousStatus: {
      id: 'open',
      label: 'Open',
      isTerminal: false,
      pausesSla: false,
    },
    nextStatus: {
      id: 'resolved',
      label: 'Resolved',
      isTerminal: true,
      terminalKind: 'resolved',
      pausesSla: false,
    },
    isReopen: false,
    ...overrides,
  });

  beforeEach(() => {
    tickets = {
      findOneAndUpdate: jest.fn(() =>
        selectLean({
          ticketNumber: 'TKT-00007',
          contactId: 'contact_1',
          ownerId: 'user_1',
        }),
      ),
      findOne: jest.fn(),
      updateOne: jest.fn(() => ({
        setOptions: jest.fn(() => execQuery({ modifiedCount: 1 })),
      })),
    };
    events = { emit: jest.fn() };
    service = new TicketCsatService(tickets, events);
  });

  describe('minting', () => {
    it('should mint a survey once the ticket reaches a terminal status', async () => {
      await service.onStatusChanged(resolvedTransition());

      expect(tickets.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ csatToken: null, csatScore: null }),
        expect.objectContaining({
          $set: expect.objectContaining({ csatToken: expect.any(String) }),
        }),
        { new: true },
      );
      expect(events.emit).toHaveBeenCalledWith(
        'ticket.csat.requested',
        expect.objectContaining({ ticketNumber: 'TKT-00007' }),
      );
    });

    it('should not mint on a non-terminal transition', async () => {
      await service.onStatusChanged(
        resolvedTransition({
          nextStatus: {
            id: 'open',
            label: 'Open',
            isTerminal: false,
            terminalKind: null,
            pausesSla: false,
          },
        }),
      );

      expect(tickets.findOneAndUpdate).not.toHaveBeenCalled();
    });

    /**
     * A reopened-and-re-resolved ticket keeps its original survey: asking the
     * customer to rate the same case twice is worse than not asking again.
     */
    it('should stay quiet when a survey already exists', async () => {
      tickets.findOneAndUpdate.mockReturnValue(selectLean(null));

      await service.onStatusChanged(resolvedTransition());

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('submission', () => {
    const survey = (overrides: Record<string, unknown> = {}) => ({
      _id: 'ticket_1',
      tenantId: 'tenant_1',
      ticketNumber: 'TKT-00007',
      subject: 'Duplicate charge',
      csatScore: null,
      csatTokenExpiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });

    beforeEach(() => {
      tickets.findOne.mockReturnValue(selectLean(survey()));
    });

    it('should reject a token that is not the minted shape', async () => {
      await expect(service.submit('nope', { score: 5 })).rejects.toThrow(
        NotFoundException,
      );
      expect(tickets.findOne).not.toHaveBeenCalled();
    });

    it('should reject an expired survey link', async () => {
      tickets.findOne.mockReturnValue(
        selectLean(
          survey({ csatTokenExpiresAt: new Date(Date.now() - 60_000) }),
        ),
      );

      await expect(service.submit(TOKEN, { score: 5 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should reject a score outside 1..5', async () => {
      await expect(service.submit(TOKEN, { score: 9 })).rejects.toThrow(
        BadRequestException,
      );
    });

    /** The token is spent, so a forwarded link cannot overwrite the score. */
    it('should record the score and burn the token', async () => {
      await expect(
        service.submit(TOKEN, { score: 4, comment: 'Quick fix' }),
      ).resolves.toEqual({ success: true });

      expect(tickets.updateOne).toHaveBeenCalledWith(
        { _id: 'ticket_1', csatToken: TOKEN },
        {
          $set: expect.objectContaining({
            csatScore: 4,
            csatComment: 'Quick fix',
            csatToken: null,
          }),
        },
      );
    });

    it('should refuse a replayed submission', async () => {
      tickets.updateOne.mockReturnValue({
        setOptions: jest.fn(() => execQuery({ modifiedCount: 0 })),
      });

      await expect(service.submit(TOKEN, { score: 4 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should never expose the ticket body on the public survey page', async () => {
      await expect(service.describe(TOKEN)).resolves.toEqual({
        ticketNumber: 'TKT-00007',
        subject: 'Duplicate charge',
        alreadyAnswered: false,
      });
    });
  });
});
