import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ConversionService } from './conversion.service';
import { ConversationRepository } from '../repositories/conversation.repository';
import { DealRepository } from '../../deals/infrastructure/persistence/document/repositories/deal.repository';
import { TicketRepository } from '../../tickets/infrastructure/persistence/document/repositories/ticket.repository';

describe('ConversionService', () => {
  let service: ConversionService;
  let conversationRepoMock: any;
  let dealRepoMock: any;
  let ticketRepoMock: any;

  beforeEach(async () => {
    conversationRepoMock = {
      findById: jest.fn(),
    };

    dealRepoMock = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(null),
    };

    ticketRepoMock = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversionService,
        { provide: ConversationRepository, useValue: conversationRepoMock },
        { provide: DealRepository, useValue: dealRepoMock },
        { provide: TicketRepository, useValue: ticketRepoMock },
      ],
    }).compile();

    service = module.get<ConversionService>(ConversionService);
  });

  // ─── linkMessages ────────────────────────────────────────────────────────────

  it('should link messages to a Deal', async () => {
    conversationRepoMock.findById.mockResolvedValueOnce({
      id: 'conv_001',
      tenantId: 'tenant_1',
    });
    dealRepoMock.findOne.mockResolvedValueOnce({
      id: 'deal_001',
      linkedMessageIds: ['msg_001'],
    });

    const result = await service.linkMessages('tenant_1', 'conv_001', {
      targetType: 'deal',
      targetId: 'deal_001',
      messageIds: ['msg_002', 'msg_003'],
    });

    expect(result.linked).toBe(2);
    expect(dealRepoMock.update).toHaveBeenCalledWith(
      'deal_001',
      expect.objectContaining({
        linkedMessageIds: ['msg_001', 'msg_002', 'msg_003'],
      }),
    );
  });

  it('should link messages to a Ticket', async () => {
    conversationRepoMock.findById.mockResolvedValueOnce({
      id: 'conv_001',
      tenantId: 'tenant_1',
    });
    ticketRepoMock.findOne.mockResolvedValueOnce({
      id: 'ticket_001',
      linkedMessageIds: [],
    });

    const result = await service.linkMessages('tenant_1', 'conv_001', {
      targetType: 'ticket',
      targetId: 'ticket_001',
      messageIds: ['msg_010'],
    });

    expect(result.linked).toBe(1);
    expect(ticketRepoMock.update).toHaveBeenCalledWith(
      'ticket_001',
      expect.objectContaining({
        linkedMessageIds: ['msg_010'],
      }),
    );
  });

  it('should throw NotFoundException when conversation not found', async () => {
    conversationRepoMock.findById.mockResolvedValueOnce(null);

    await expect(
      service.linkMessages('tenant_1', 'conv_999', {
        targetType: 'deal',
        targetId: 'deal_001',
        messageIds: ['msg_001'],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('should throw BadRequestException for empty messageIds', async () => {
    conversationRepoMock.findById.mockResolvedValueOnce({
      id: 'conv_001',
      tenantId: 'tenant_1',
    });

    await expect(
      service.linkMessages('tenant_1', 'conv_001', {
        targetType: 'deal',
        targetId: 'deal_001',
        messageIds: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should deduplicate message IDs when linking', async () => {
    conversationRepoMock.findById.mockResolvedValueOnce({
      id: 'conv_001',
      tenantId: 'tenant_1',
    });
    dealRepoMock.findOne.mockResolvedValueOnce({
      id: 'deal_001',
      linkedMessageIds: ['msg_001'],
    });

    await service.linkMessages('tenant_1', 'conv_001', {
      targetType: 'deal',
      targetId: 'deal_001',
      messageIds: ['msg_001', 'msg_002'], // msg_001 is a duplicate
    });

    expect(dealRepoMock.update).toHaveBeenCalledWith(
      'deal_001',
      expect.objectContaining({
        linkedMessageIds: ['msg_001', 'msg_002'], // Deduplicated
      }),
    );
  });
});
