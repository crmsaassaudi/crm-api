import { ObjectAclService } from './object-acl.service';

/** Chainable `.lean().exec()` stub matching the Mongoose query shape used here. */
function chain(result: any) {
  return { lean: () => ({ exec: () => Promise.resolve(result) }) };
}

describe('ObjectAclService — OBJECT_ACL audit trail', () => {
  let aclModel: any;
  let audit: any;
  let service: ObjectAclService;

  const entry = {
    tenantId: 't1',
    resourceType: 'deals',
    resourceId: 'deal_1',
    principalType: 'user' as const,
    principalId: 'user_1',
    permissions: ['view'],
  };

  beforeEach(() => {
    aclModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      find: jest.fn(),
      deleteMany: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ObjectAclService(aclModel, audit);
  });

  describe('upsert', () => {
    it('should record a "create" audit entry when no prior entry existed', async () => {
      aclModel.findOne.mockReturnValue(chain(null));
      const saved = { ...entry, isDeny: false };
      aclModel.findOneAndUpdate.mockReturnValue(chain(saved));

      await service.upsert(entry);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'OBJECT_ACL',
          action: 'create',
          targetType: 'deals',
          targetId: 'deal_1',
          before: null,
          after: saved,
        }),
      );
    });

    it('should record an "update" audit entry when a prior entry existed', async () => {
      const existing = { ...entry, permissions: ['view'], isDeny: false };
      aclModel.findOne.mockReturnValue(chain(existing));
      const saved = { ...entry, permissions: ['view', 'edit'], isDeny: false };
      aclModel.findOneAndUpdate.mockReturnValue(chain(saved));

      await service.upsert({ ...entry, permissions: ['view', 'edit'] });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'OBJECT_ACL',
          action: 'update',
          before: existing,
          after: saved,
        }),
      );
    });
  });

  describe('remove', () => {
    it('should record a "delete" audit entry when an entry was actually removed', async () => {
      const removed = { ...entry };
      aclModel.findOneAndDelete.mockReturnValue(chain(removed));

      await service.remove('t1', 'deals', 'deal_1', 'user_1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'OBJECT_ACL',
          action: 'delete',
          before: removed,
        }),
      );
    });

    it('should not write an audit entry when nothing matched', async () => {
      aclModel.findOneAndDelete.mockReturnValue(chain(null));

      await service.remove('t1', 'deals', 'deal_1', 'user_missing');

      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('removeAllForResource', () => {
    it('should record one "delete" audit entry covering every purged row', async () => {
      const removed = [entry, { ...entry, principalId: 'user_2' }];
      aclModel.find.mockReturnValue(chain(removed));
      aclModel.deleteMany.mockReturnValue({ exec: () => Promise.resolve({}) });

      await service.removeAllForResource('t1', 'deals', 'deal_1');

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'OBJECT_ACL',
          action: 'delete',
          before: removed,
        }),
      );
    });

    it('should not write an audit entry when the resource had no ACL entries', async () => {
      aclModel.find.mockReturnValue(chain([]));
      aclModel.deleteMany.mockReturnValue({ exec: () => Promise.resolve({}) });

      await service.removeAllForResource('t1', 'deals', 'deal_empty');

      expect(audit.record).not.toHaveBeenCalled();
    });
  });
});
