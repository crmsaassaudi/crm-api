import { ContactsService } from './contacts.service';
import {
  createContact,
  createContactDto,
} from '../test/factories/contact.factory';
import { createClsMock } from '../test/mocks/cls.mock';
import { createEventBusMock } from '../test/mocks/event-bus.mock';
import { createQueueMock } from '../test/mocks/queue.mock';
import { createMongooseModelMock } from '../test/mocks/mongoose-model.mock';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';

describe('ContactsService', () => {
  let service: ContactsService;
  let repository: any;
  let cls: ReturnType<typeof createClsMock>;
  let eventEmitter: ReturnType<typeof createEventBusMock>;
  let mergeService: any;
  let tagsService: any;
  let settingsService: any;
  let authorization: any;
  let identitySync: any;
  let customFieldValidator: any;

  beforeEach(() => {
    repository = {
      create: jest.fn(),
      findOne: jest.fn(),
      findManyWithPagination: jest.fn(),
      findManyWithCursorPagination: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      checkDuplicate: jest.fn(),
      findByOmniIdentity: jest.fn(),
      addOmniIdentity: jest.fn(),
      addEmailIfMissing: jest.fn(),
      addTagsToContacts: jest.fn(),
      updateWithVersionCheck: jest.fn(),
      pushStageHistory: jest.fn(),
      touchLastActivity: jest.fn(),
      getStageHistory: jest.fn(),
      // Identity uniqueness is now enforced on the API path, not only in the
      // import worker. Default: no conflict.
      findDuplicateByIdentity: jest.fn().mockResolvedValue(null),
      restore: jest.fn(),
      findDeleted: jest.fn(),
    };
    repository.updateWithVersionCheck.mockImplementation(
      (id: string, _version: number, data: any, session?: any) =>
        repository.update(id, data, session),
    );

    cls = createClsMock();
    eventEmitter = createEventBusMock();

    settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
    };

    authorization = {
      canPerformAction: jest.fn(() => Promise.resolve({ allowed: true })),
    };

    mergeService = {
      merge: jest.fn(),
      preview: jest.fn(),
      unmerge: jest.fn(),
      history: jest.fn(),
    };

    // bulkTagContacts validates ids against the tag catalogue, so the catalogue
    // has to contain whatever the tests tag with.
    tagsService = {
      findAll: jest.fn(() => Promise.resolve([{ id: 'vip' }, { id: 'lead' }])),
    };

    identitySync = {
      syncFromContact: jest.fn(() => Promise.resolve()),
      derive: jest.fn(() => []),
      assertNoConflicts: jest.fn(() => Promise.resolve()),
    };

    // Pass-through by default: these tests are about the service, not the
    // registry. The validator's own behaviour is covered in its spec.
    customFieldValidator = {
      validate: jest.fn((_module: string, values: any) =>
        Promise.resolve(values),
      ),
    };

    // Minimal construction — only fields needed for the methods under test.
    // Other dependencies are stubbed as empty objects since they are not exercised.
    service = new ContactsService(
      repository,
      {} as any, // accountsService
      {} as any, // dealsService
      settingsService as any,
      cls as any,
      eventEmitter as any,
      {
        runWithEvent: jest.fn(async (mutate: any, build: any) => {
          const result = await mutate(undefined);
          const payload = build(result);
          if (payload) {
            await eventEmitter.emitAsync(
              `${payload.event}.${payload.object}`,
              payload,
            );
          }
          return result;
        }),
      } as any,
      {} as any, // exportStorageService
      // mergeIdentity now serialises on the identity — the read-then-write
      // uniqueness check has no unique index behind it. Run the callback through.
      {
        acquire: jest.fn((_key: string, _ttl: unknown, fn: any) => fn()),
      } as any, // lockService
      { emit: jest.fn() } as any, // entityAudit
      {} as any, // activityLog
      { create: jest.fn().mockReturnValue({}) } as any, // exportStorageFactory
      mergeService as any, // mergeService
      customFieldValidator as any, // customFieldValidator
      { getByModule: jest.fn(() => Promise.resolve([])) } as any, // customFields
      tagsService as any, // tagsService
      authorization as any, // authorization
      // The identity mirror is a non-throwing projection; these tests assert the
      // contact write, not the projection (covered in its own spec).
      identitySync as any, // identitySync
      {} as any, // redis
      createQueueMock() as any, // exportQueue
      createQueueMock() as any, // importQueue
      createMongooseModelMock() as any, // importJobModel
      createMongooseModelMock() as any, // exportJobModel
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // CREATE
  // ═══════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('should create a contact with valid payload', async () => {
      const dto = createContactDto();
      const expected = createContact({ ...dto });
      repository.create.mockResolvedValue(expected);

      const result = await service.create(dto as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: dto.firstName,
          lastName: dto.lastName,
          emails: dto.emails,
          phones: dto.phones,
        }),
        undefined,
      );
      expect(result).toEqual(expected);
    });

    it('should emit automation event after creation', async () => {
      const contact = createContact();
      repository.create.mockResolvedValue(contact);

      await service.create(createContactDto() as any);

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        expect.stringContaining('record_created'),
        expect.objectContaining({
          tenantId: 'tenant_1',
          event: 'record_created',
          object: 'Contact',
        }),
      );
    });

    it('should normalize empty ownerId to undefined', async () => {
      const dto = createContactDto({ ownerId: '' });
      repository.create.mockResolvedValue(createContact());

      await service.create(dto as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: undefined,
        }),
        undefined,
      );
    });

    it('should default emails and phones to empty arrays when not provided', async () => {
      const dto = createContactDto({ emails: undefined, phones: undefined });
      repository.create.mockResolvedValue(createContact());

      await service.create(dto as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          emails: [],
          phones: [],
        }),
        undefined,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FIND ONE
  // ═══════════════════════════════════════════════════════════════════
  describe('findOne', () => {
    it('should return contact by id', async () => {
      const contact = createContact();
      repository.findOne.mockResolvedValue(contact);

      const result = await service.findOne('contact_1');

      expect(repository.findOne).toHaveBeenCalledWith({ _id: 'contact_1' });
      expect(result).toEqual(contact);
    });

    it('should return null when contact not found', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.findOne('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // UPDATE
  // ═══════════════════════════════════════════════════════════════════
  describe('update', () => {
    it('should update contact with valid data', async () => {
      const existing = createContact();
      const updated = createContact({ firstName: 'Updated' });
      repository.findOne.mockResolvedValue(existing);
      repository.update.mockResolvedValue(updated);

      const result = await service.update('contact_1', {
        firstName: 'Updated',
      } as any);

      expect(repository.update).toHaveBeenCalledWith(
        'contact_1',
        expect.objectContaining({ firstName: 'Updated' }),
        undefined,
      );
      expect(result?.firstName).toBe('Updated');
    });

    it('should emit automation event on field update', async () => {
      repository.findOne.mockResolvedValue(createContact());
      repository.update.mockResolvedValue(createContact({ firstName: 'New' }));

      await service.update('contact_1', { firstName: 'New' } as any);

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        expect.stringContaining('field_updated'),
        expect.objectContaining({
          event: 'field_updated',
          object: 'Contact',
        }),
      );
    });

    it('should promote shadow contact when real data added', async () => {
      const shadow = createContact({ isShadow: true, emails: [] });
      repository.findOne.mockResolvedValue(shadow);
      repository.update.mockResolvedValue(createContact({ isShadow: false }));

      await service.update('contact_1', {
        emails: ['real@example.com'],
      } as any);

      expect(repository.update).toHaveBeenCalledWith(
        'contact_1',
        expect.objectContaining({ isShadow: false }),
        undefined,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════════
  describe('remove', () => {
    it('should remove contact by id', async () => {
      repository.findOne.mockResolvedValue(createContact());
      repository.remove.mockResolvedValue(undefined);

      await service.remove('contact_1');

      expect(repository.remove).toHaveBeenCalledWith('contact_1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // MERGE IDENTITY
  // ═══════════════════════════════════════════════════════════════════
  describe('mergeIdentity', () => {
    it('should merge identity into existing contact', async () => {
      const contact = createContact();
      const merged = createContact({
        omniIdentities: [{ channelType: 'facebook', senderId: 'psid_123' }],
      });
      repository.findOne.mockResolvedValue(contact);
      repository.findByOmniIdentity.mockResolvedValue(null);
      repository.addOmniIdentity.mockResolvedValue(merged);

      const result = await service.mergeIdentity('contact_1', {
        channelType: 'facebook',
        senderId: 'psid_123',
      });

      expect(result.omniIdentities).toHaveLength(1);
    });

    it('should throw NotFoundException when contact not found', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.mergeIdentity('nonexistent', {
          channelType: 'facebook',
          senderId: 'psid_123',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when identity already linked to another contact', async () => {
      repository.findOne.mockResolvedValue(createContact({ id: 'contact_1' }));
      repository.findByOmniIdentity.mockResolvedValue(
        createContact({ id: 'contact_OTHER' }),
      );

      await expect(
        service.mergeIdentity('contact_1', {
          channelType: 'facebook',
          senderId: 'psid_123',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // CHECK DUPLICATE
  // ═══════════════════════════════════════════════════════════════════
  describe('checkDuplicate', () => {
    it('should return isDuplicate=false when no matches', async () => {
      repository.checkDuplicate.mockResolvedValue([]);

      const result = await service.checkDuplicate({ emails: 'test@x.com' });

      expect(result.isDuplicate).toBe(false);
      expect(result.duplicates).toHaveLength(0);
    });

    it('should return isDuplicate=true with matching contacts', async () => {
      repository.checkDuplicate.mockResolvedValue([
        createContact({ emails: ['test@x.com'] }),
      ]);

      const result = await service.checkDuplicate({ emails: 'test@x.com' });

      expect(result.isDuplicate).toBe(true);
      expect(result.duplicates).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // BULK TAG
  // ═══════════════════════════════════════════════════════════════════
  describe('bulkTagContacts', () => {
    it('should add tags to contacts', async () => {
      repository.addTagsToContacts.mockResolvedValue({
        matchedCount: 2,
        modifiedCount: 2,
      });

      const result = await service.bulkTagContacts({
        contactIds: ['c1', 'c2'],
        tags: ['vip'],
      });

      expect(result.success).toBe(true);
      expect(result.modifiedCount).toBe(2);
    });

    it('should throw BadRequestException when contactIds is empty', async () => {
      await expect(
        service.bulkTagContacts({ contactIds: [], tags: ['vip'] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when tags is empty', async () => {
      await expect(
        service.bulkTagContacts({ contactIds: ['c1'], tags: [] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should deduplicate and trim tags', async () => {
      repository.addTagsToContacts.mockResolvedValue({
        matchedCount: 1,
        modifiedCount: 1,
      });

      await service.bulkTagContacts({
        contactIds: ['c1'],
        tags: ['vip', ' vip ', 'vip'],
      });

      expect(repository.addTagsToContacts).toHaveBeenCalledWith(
        ['c1'],
        ['vip'],
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // OWNERSHIP TRANSFER (M-3)
  // ═══════════════════════════════════════════════════════════════════
  describe('ownership transfer', () => {
    const withPolicy = (policy: Record<string, unknown> | null) =>
      settingsService.getSetting.mockImplementation((key: string) =>
        Promise.resolve(key === 'data_access_policy' ? policy : null),
      );

    beforeEach(() => {
      repository.findOne.mockResolvedValue(
        createContact({ id: 'c1', ownerId: 'owner_a' }),
      );
      repository.update.mockResolvedValue(
        createContact({ ownerId: 'owner_b' }),
      );
    });

    it('should NOT enforce the permission unless the tenant opted in', async () => {
      // Enabling this globally on deploy would revoke a capability every existing
      // tenant's roles grant in practice — changing live authorization semantics
      // as a side effect of shipping.
      withPolicy(null);
      authorization.canPerformAction.mockResolvedValue({ allowed: false });

      await expect(
        service.update('c1', { ownerId: 'owner_b' } as any),
      ).resolves.toBeTruthy();
      expect(authorization.canPerformAction).not.toHaveBeenCalled();
    });

    it('should reject a transfer without contacts:assign once enforced', async () => {
      withPolicy({ enforce_transfer_permission: true });
      authorization.canPerformAction.mockResolvedValue({ allowed: false });

      await expect(
        service.update('c1', { ownerId: 'owner_b' } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should allow a transfer when the caller holds contacts:assign', async () => {
      withPolicy({ enforce_transfer_permission: true });
      authorization.canPerformAction.mockResolvedValue({ allowed: true });

      await expect(
        service.update('c1', { ownerId: 'owner_b' } as any),
      ).resolves.toBeTruthy();
      expect(authorization.canPerformAction).toHaveBeenCalledWith(
        expect.objectContaining({
          rule: { action: 'assign', resource: 'contacts' },
        }),
      );
    });

    it('should not treat an unchanged ownerId as a transfer', async () => {
      // Editing a phone number while the form round-trips the existing owner must
      // not demand the transfer permission.
      withPolicy({ enforce_transfer_permission: true });
      authorization.canPerformAction.mockResolvedValue({ allowed: false });

      await expect(
        service.update('c1', {
          ownerId: 'owner_a',
          phones: ['+84901112222'],
        } as any),
      ).resolves.toBeTruthy();
      expect(authorization.canPerformAction).not.toHaveBeenCalled();
    });

    it('should not check the permission when ownerId is absent from the patch', async () => {
      withPolicy({ enforce_transfer_permission: true });
      authorization.canPerformAction.mockResolvedValue({ allowed: false });

      await expect(
        service.update('c1', { firstName: 'Renamed' } as any),
      ).resolves.toBeTruthy();
      expect(authorization.canPerformAction).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FIND BY EMAIL (tenant isolation)
  // ═══════════════════════════════════════════════════════════════════
  describe('findByEmail — Tenant Isolation', () => {
    it('should include tenantId in query', async () => {
      repository.findOne.mockResolvedValue(null);

      await service.findByEmail('tenant_1', 'Test@Example.com');

      expect(repository.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant_1',
        emails: 'test@example.com', // lowercased
      });
    });
  });
});
