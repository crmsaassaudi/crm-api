import { ContactsService } from './contacts.service';
import {
  createContact,
  createContactDto,
} from '../test/factories/contact.factory';
import { createClsMock } from '../test/mocks/cls.mock';
import { createEventBusMock } from '../test/mocks/event-bus.mock';
import { createQueueMock } from '../test/mocks/queue.mock';
import { createMongooseModelMock } from '../test/mocks/mongoose-model.mock';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ContactsService', () => {
  let service: ContactsService;
  let repository: any;
  let cls: ReturnType<typeof createClsMock>;
  let eventEmitter: ReturnType<typeof createEventBusMock>;

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
    };

    cls = createClsMock();
    eventEmitter = createEventBusMock();

    const settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
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
      {} as any, // exportStorageService
      {} as any, // lockService
      { emit: jest.fn() } as any, // entityAudit
      {} as any, // activityLog
      { create: jest.fn().mockReturnValue({}) } as any, // exportStorageFactory
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
      );
      expect(result).toEqual(expected);
    });

    it('should emit automation event after creation', async () => {
      const contact = createContact();
      repository.create.mockResolvedValue(contact);

      await service.create(createContactDto() as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
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
      );
      expect(result?.firstName).toBe('Updated');
    });

    it('should emit automation event on field update', async () => {
      repository.findOne.mockResolvedValue(createContact());
      repository.update.mockResolvedValue(createContact({ firstName: 'New' }));

      await service.update('contact_1', { firstName: 'New' } as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
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
