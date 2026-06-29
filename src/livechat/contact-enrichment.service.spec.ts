import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ContactEnrichmentService } from './contact-enrichment.service';
import { ContactsService } from '../contacts/contacts.service';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { IdentityService } from '../omni-inbound/services/identity.service';
import { LivechatWidgetService } from './livechat-widget.service';

/**
 * Unit tests for ContactEnrichmentService — dynamic field mapping
 *
 * Tests that buildContactUpdate correctly:
 * 1. Detects email/phone by contactField TARGET, not by key name
 * 2. Builds displayName from firstName/lastName targets
 * 3. Falls back to standard keys when no contactField mapping exists
 * 4. Maps custom fields correctly
 * 5. Caches contactId even when conversationId is null (race condition fix)
 */
describe('ContactEnrichmentService', () => {
  let service: ContactEnrichmentService;
  let identityServiceMock: any;
  let contactsServiceMock: any;
  let conversationRepoMock: any;
  let widgetServiceMock: any;

  beforeEach(async () => {
    identityServiceMock = {
      updateIdentity: jest.fn().mockResolvedValue(undefined),
    };

    contactsServiceMock = {
      findOne: jest.fn().mockResolvedValue(null),
      findByEmail: jest.fn().mockResolvedValue(null),
      findByPhone: jest.fn().mockResolvedValue(null),
      findBySenderId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'contact_new', _id: 'contact_new' }),
      update: jest.fn().mockResolvedValue(undefined),
      mergeIdentity: jest.fn().mockResolvedValue(undefined),
    };

    conversationRepoMock = {
      updateCustomerInfo: jest.fn().mockResolvedValue(null),
      updateContactId: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue(null),
    };

    widgetServiceMock = {
      getCachedWidget: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactEnrichmentService,
        { provide: ContactsService, useValue: contactsServiceMock },
        { provide: ConversationRepository, useValue: conversationRepoMock },
        { provide: IdentityService, useValue: identityServiceMock },
        { provide: LivechatWidgetService, useValue: widgetServiceMock },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get<ContactEnrichmentService>(ContactEnrichmentService);
  });

  // ── buildContactUpdate tests (via private method access) ───────────────

  describe('buildContactUpdate — dynamic field detection', () => {
    // Access private method for isolated unit testing
    const callBuildContactUpdate = (
      svc: any,
      identityData: Record<string, any>,
      fieldMappings: Array<{ key: string; contactField?: string }>,
    ) => svc.buildContactUpdate(identityData, fieldMappings);

    it('should detect email by contactField "emails", not by key name', () => {
      const result = callBuildContactUpdate(service, {
        lien_he: 'test@example.com',
      }, [
        { key: 'lien_he', contactField: 'emails' },
      ]);

      expect(result.email).toBe('test@example.com');
      expect(result.contactUpdate.emails).toEqual(['test@example.com']);
    });

    it('should detect phone by contactField "phones", not by key name', () => {
      const result = callBuildContactUpdate(service, {
        sdt: '0901234567',
      }, [
        { key: 'sdt', contactField: 'phones' },
      ]);

      expect(result.phone).toBe('0901234567');
      expect(result.contactUpdate.phones).toEqual(['0901234567']);
    });

    it('should build displayName from firstName + lastName targets', () => {
      const result = callBuildContactUpdate(service, {
        ho: 'Nguyen',
        ten: 'Toan',
      }, [
        { key: 'ho', contactField: 'firstName' },
        { key: 'ten', contactField: 'lastName' },
      ]);

      expect(result.displayName).toBe('Nguyen Toan');
    });

    it('should build displayName from single lastName target', () => {
      const result = callBuildContactUpdate(service, {
        name: 'Nguyen Toan',
      }, [
        { key: 'name', contactField: 'lastName' },
      ]);

      expect(result.displayName).toBe('Nguyen Toan');
      expect(result.contactUpdate.lastName).toBe('Nguyen Toan');
    });

    it('should handle custom fields mapping', () => {
      const result = callBuildContactUpdate(service, {
        order_id: 'ORD-123',
      }, [
        { key: 'order_id', contactField: 'customFields.order_id' },
      ]);

      expect(result.contactUpdate.customFields).toEqual({ order_id: 'ORD-123' });
    });

    it('should skip fields with no contactField mapping', () => {
      const result = callBuildContactUpdate(service, {
        note: 'some note',
      }, [
        { key: 'note' }, // no contactField
      ]);

      expect(Object.keys(result.contactUpdate)).toHaveLength(0);
      expect(result.email).toBeUndefined();
      expect(result.phone).toBeUndefined();
      expect(result.displayName).toBeUndefined();
    });

    it('should fallback to standard keys when no contactField matches', () => {
      const result = callBuildContactUpdate(service, {
        email: 'user@test.com',
        phone: '123456',
        name: 'Test User',
      }, [
        // Empty field mappings — no contactField targets
      ]);

      expect(result.email).toBe('user@test.com');
      expect(result.phone).toBe('123456');
      expect(result.displayName).toBe('Test User');
    });

    it('should handle full dynamic form with custom keys', () => {
      const result = callBuildContactUpdate(service, {
        ho_ten: 'Nguyen Van A',
        email_lien_he: 'nva@company.com',
        sdt: '0987654321',
        cong_ty: 'ACME Corp',
      }, [
        { key: 'ho_ten', contactField: 'firstName' },
        { key: 'email_lien_he', contactField: 'emails' },
        { key: 'sdt', contactField: 'phones' },
        { key: 'cong_ty', contactField: 'companyName' },
      ]);

      expect(result.email).toBe('nva@company.com');
      expect(result.phone).toBe('0987654321');
      expect(result.displayName).toContain('Nguyen Van A');
      expect(result.contactUpdate.companyName).toBe('ACME Corp');
      expect(result.contactUpdate.emails).toEqual(['nva@company.com']);
      expect(result.contactUpdate.phones).toEqual(['0987654321']);
    });

    it('should lowercase email values', () => {
      const result = callBuildContactUpdate(service, {
        email: 'User@EXAMPLE.COM',
      }, [
        { key: 'email', contactField: 'emails' },
      ]);

      expect(result.email).toBe('user@example.com');
      expect(result.contactUpdate.emails).toEqual(['user@example.com']);
    });

    it('should skip empty/null/undefined values', () => {
      const result = callBuildContactUpdate(service, {
        email: '',
        phone: null,
        name: undefined,
      }, [
        { key: 'email', contactField: 'emails' },
        { key: 'phone', contactField: 'phones' },
        { key: 'name', contactField: 'firstName' },
      ]);

      expect(result.email).toBeUndefined();
      expect(result.phone).toBeUndefined();
      expect(result.displayName).toBeUndefined();
      expect(Object.keys(result.contactUpdate)).toHaveLength(0);
    });
  });

  // ── Identity cache tests ──────────────────────────────────────────────

  describe('enrichFromPreChat — identity cache', () => {
    it('should cache contactId even when conversationId is null', async () => {
      // Setup: widget returns field mappings
      widgetServiceMock.getCachedWidget.mockResolvedValue({
        preChatForm: {
          fields: [
            { key: 'email', contactField: 'emails' },
            { key: 'name', contactField: 'firstName' },
          ],
        },
      });

      contactsServiceMock.findByEmail.mockResolvedValue(null);
      contactsServiceMock.findBySenderId.mockResolvedValue(null);
      contactsServiceMock.create.mockResolvedValue({ id: 'contact_abc', _id: 'contact_abc' });

      await service.enrichFromPreChat({
        tenantId: 'tenant_1',
        visitorId: 'visitor_xyz',
        channelId: 'channel_1',
        widgetId: 'widget_1',
        conversationId: undefined, // NO conversation yet
        identityData: { email: 'test@example.com', name: 'Test User' },
      });

      // Should cache contactId in identity service even without conversationId
      expect(identityServiceMock.updateIdentity).toHaveBeenCalledWith(
        'livechat',
        'channel_1',
        'visitor_xyz',
        expect.objectContaining({
          contactId: 'contact_abc',
          conversationId: null,
        }),
        'tenant_1',
      );
    });
  });
});
