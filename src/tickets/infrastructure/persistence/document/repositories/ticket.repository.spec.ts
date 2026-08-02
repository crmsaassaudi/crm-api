import { Types } from 'mongoose';
import { TicketRepository } from './ticket.repository';

describe('TicketRepository list filter hardening', () => {
  const buildWhere = (filters: unknown) => {
    const repository = Object.create(TicketRepository.prototype) as any;
    return repository.buildListWhere({ filters: JSON.stringify(filters) });
  };

  it('should not copy Mongo operators from table filters into the query', () => {
    const where = buildWhere([
      { id: 'status', value: { $ne: null } },
      { id: 'owner', value: { $gt: '' } },
    ]);

    expect(where.statusId).toBeUndefined();
    expect(where.ownerId).toBeUndefined();
    expect(JSON.stringify(where)).not.toContain('$ne');
    expect(JSON.stringify(where)).not.toContain('$gt');
  });

  it('should keep valid ObjectId table filters', () => {
    const statusId = new Types.ObjectId().toHexString();
    const ownerId = new Types.ObjectId().toHexString();
    const where = buildWhere([
      { id: 'status', value: statusId },
      { id: 'owner', value: ownerId },
    ]);

    expect(where.statusId).toEqual({ $in: [statusId] });
    expect(where.ownerId).toEqual({ $in: [ownerId] });
  });
});
