import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BulkTagTicketsDto,
  MergeTicketDto,
  TicketListQueryDto,
} from './ticket-operations.dto';

describe('ticket operation DTOs', () => {
  it('should reject Mongo operators in merge sourceId', async () => {
    const dto = plainToInstance(MergeTicketDto, {
      sourceId: { $ne: null },
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('should reject operators and malformed ids in bulk ticket ids', async () => {
    const dto = plainToInstance(BulkTagTicketsDto, {
      ticketIds: [{ $ne: null }],
      tags: ['not-an-object-id'],
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('should cap list page size', async () => {
    const dto = plainToInstance(TicketListQueryDto, {
      page: '1',
      limit: '1000',
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('should accept valid ids and bounded pagination', async () => {
    const dto = plainToInstance(BulkTagTicketsDto, {
      ticketIds: ['60d0fe4f5311236168a109ca'],
      tags: ['60d0fe4f5311236168a109cb'],
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
