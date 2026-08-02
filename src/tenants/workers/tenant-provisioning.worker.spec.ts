import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Job } from 'bullmq';

import { TenantProvisioningWorker } from './tenant-provisioning.worker';
import { TenantsRepository } from '../infrastructure/persistence/document/repositories/tenant.repository';
import { TenantAliasReservationRepository } from '../infrastructure/persistence/document/repositories/tenant-alias-reservation.repository';
import { ProvisioningJobRepository } from '../infrastructure/persistence/document/repositories/provisioning-job.repository';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { RedisService } from '../../redis/redis.service';
import { CrmBotWorkspaceProvisioningService } from '../services/crm-bot-workspace-provisioning.service';
import { TransactionManager } from '../../database/transaction-manager.service';
import { ProvisioningStatus } from '../domain/tenant';
import { TenantProvisioningJobData } from '../interfaces/tenant-provisioning.interfaces';

/**
 * The saga's two hard questions are "what does a retry find already done" and
 * "what may a failure delete". Both were answered wrongly: every failure
 * compensated even though the job was rethrown for BullMQ to retry, so each
 * attempt destroyed what the next one needed, and the bot workspace was never
 * undone at all.
 */
describe('TenantProvisioningWorker', () => {
  let worker: TenantProvisioningWorker;
  let tenantsRepository: jest.Mocked<Partial<TenantsRepository>>;
  let aliasReservationRepository: any;
  let keycloakAdminService: any;
  let userRepository: any;
  let botWorkspaceService: any;

  const JOB_DATA: TenantProvisioningJobData = {
    provisioningId: 'prov_1',
    source: 'PLG',
    alias: 'acme',
    companyName: 'Acme',
    email: 'owner@acme.test',
    fullName: 'Ada Lovelace',
    useCase: 'sales',
  } as TenantProvisioningJobData;

  const makeJob = (
    overrides: Partial<{ attemptsStarted: number; attempts: number }> = {},
  ): Job<TenantProvisioningJobData> =>
    ({
      data: JOB_DATA,
      attemptsMade: (overrides.attemptsStarted ?? 1) - 1,
      attemptsStarted: overrides.attemptsStarted ?? 1,
      opts: { attempts: overrides.attempts ?? 3 },
    }) as unknown as Job<TenantProvisioningJobData>;

  beforeEach(async () => {
    tenantsRepository = {
      create: jest.fn().mockResolvedValue({ id: 'tenant_new' }),
      findByAlias: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(null),
      updateOwner: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    aliasReservationRepository = {
      confirm: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    keycloakAdminService = {
      findOrganizationByAlias: jest.fn().mockResolvedValue(null),
      createOrganization: jest.fn().mockResolvedValue({ id: 'kc_org' }),
      deleteOrganization: jest.fn().mockResolvedValue(undefined),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      createUser: jest.fn().mockResolvedValue({ id: 'kc_user' }),
      deleteUser: jest.fn().mockResolvedValue(undefined),
      addUserToOrganization: jest.fn().mockResolvedValue(undefined),
    };
    userRepository = {
      findByEmail: jest.fn().mockResolvedValue(null),
      upsertWithTenants: jest.fn().mockResolvedValue({ id: 'user_1' }),
      removeIfExists: jest.fn().mockResolvedValue(true),
      removeTenantMembership: jest.fn().mockResolvedValue({ id: 'user_1' }),
    };
    botWorkspaceService = {
      provisionWorkspace: jest.fn().mockResolvedValue('ws_1'),
      deprovisionWorkspace: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantProvisioningWorker,
        { provide: TenantsRepository, useValue: tenantsRepository },
        {
          provide: TenantAliasReservationRepository,
          useValue: aliasReservationRepository,
        },
        {
          provide: ProvisioningJobRepository,
          useValue: { updateStatus: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: KeycloakAdminService, useValue: keycloakAdminService },
        { provide: UserRepository, useValue: userRepository },
        {
          provide: RedisService,
          useValue: { set: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CrmBotWorkspaceProvisioningService,
          useValue: botWorkspaceService,
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: ClsService,
          useValue: { runWith: (_: any, fn: any) => fn() },
        },
        {
          provide: TransactionManager,
          useValue: {
            runInTransaction: jest.fn((fn: any) => fn(undefined)),
          },
        },
      ],
    }).compile();

    worker = module.get(TenantProvisioningWorker);
    jest.spyOn(worker['logger'], 'log').mockImplementation();
    jest.spyOn(worker['logger'], 'warn').mockImplementation();
    jest.spyOn(worker['logger'], 'error').mockImplementation();
  });

  describe('happy path', () => {
    it('should provision and confirm the alias reservation', async () => {
      await worker.process(makeJob());

      expect(tenantsRepository.create).toHaveBeenCalled();
      expect(botWorkspaceService.provisionWorkspace).toHaveBeenCalled();
      expect(aliasReservationRepository.confirm).toHaveBeenCalledWith('acme');
      expect(tenantsRepository.update).toHaveBeenLastCalledWith('tenant_new', {
        provisioningStatus: ProvisioningStatus.READY,
      });
    });
  });

  describe('a failure that will be retried', () => {
    beforeEach(() => {
      botWorkspaceService.provisionWorkspace.mockRejectedValue(
        new Error('crm-bot unreachable'),
      );
    });

    it('should leave every resource in place for the next attempt', async () => {
      await expect(
        worker.process(makeJob({ attemptsStarted: 1 })),
      ).rejects.toThrow('crm-bot unreachable');

      expect(tenantsRepository.remove).not.toHaveBeenCalled();
      expect(keycloakAdminService.deleteOrganization).not.toHaveBeenCalled();
      expect(keycloakAdminService.deleteUser).not.toHaveBeenCalled();
      expect(aliasReservationRepository.delete).not.toHaveBeenCalled();
      expect(userRepository.removeIfExists).not.toHaveBeenCalled();
    });

    it('should still record why it failed', async () => {
      await expect(worker.process(makeJob())).rejects.toThrow();

      expect(tenantsRepository.update).toHaveBeenCalledWith('tenant_new', {
        provisioningStatus: ProvisioningStatus.FAILED,
        provisioningError: 'crm-bot unreachable',
      });
    });
  });

  describe('the final failure', () => {
    const finalJob = () => makeJob({ attemptsStarted: 3, attempts: 3 });

    it('should delete the bot workspace it created', async () => {
      aliasReservationRepository.confirm.mockRejectedValue(new Error('boom'));

      await expect(worker.process(finalJob())).rejects.toThrow('boom');

      expect(botWorkspaceService.deprovisionWorkspace).toHaveBeenCalledWith(
        'tenant_new',
      );
    });

    it('should remove the tenant row rather than leave it holding the alias', async () => {
      aliasReservationRepository.confirm.mockRejectedValue(new Error('boom'));

      await expect(worker.process(finalJob())).rejects.toThrow();

      expect(tenantsRepository.remove).toHaveBeenCalledWith('tenant_new');
      expect(aliasReservationRepository.delete).toHaveBeenCalledWith('acme');
    });

    it('should delete a local user it created, membership and all', async () => {
      aliasReservationRepository.confirm.mockRejectedValue(new Error('boom'));

      await expect(worker.process(finalJob())).rejects.toThrow();

      expect(userRepository.removeIfExists).toHaveBeenCalledWith('user_1');
      expect(userRepository.removeTenantMembership).not.toHaveBeenCalled();
    });

    it('should only strip the membership from a user who already existed', async () => {
      userRepository.findByEmail.mockResolvedValue({
        id: 'user_1',
        tenants: [{ tenantId: 'other_tenant' }],
      });
      aliasReservationRepository.confirm.mockRejectedValue(new Error('boom'));

      await expect(worker.process(finalJob())).rejects.toThrow();

      expect(userRepository.removeIfExists).not.toHaveBeenCalled();
      expect(userRepository.removeTenantMembership).toHaveBeenCalledWith(
        'user_1',
        'tenant_new',
      );
    });

    it('should not delete a bot workspace it never created', async () => {
      keycloakAdminService.createOrganization.mockRejectedValue(
        new Error('kc down'),
      );

      await expect(worker.process(finalJob())).rejects.toThrow('kc down');

      expect(botWorkspaceService.deprovisionWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('resuming after a partial attempt', () => {
    beforeEach(() => {
      keycloakAdminService.findOrganizationByAlias.mockResolvedValue({
        id: 'kc_org_existing',
      });
      (tenantsRepository.findByAlias as jest.Mock).mockResolvedValue({
        id: 'tenant_existing',
        keycloakOrgId: 'kc_org_existing',
        provisioningStatus: ProvisioningStatus.FAILED,
      } as any);
    });

    it('should adopt the abandoned tenant instead of creating a second one', async () => {
      await worker.process(makeJob({ attemptsStarted: 2 }));

      expect(tenantsRepository.create).not.toHaveBeenCalled();
      expect(tenantsRepository.update).toHaveBeenLastCalledWith(
        'tenant_existing',
        { provisioningStatus: ProvisioningStatus.READY },
      );
    });

    it('should reuse the Keycloak organization instead of conflicting on its alias', async () => {
      await worker.process(makeJob({ attemptsStarted: 2 }));

      expect(keycloakAdminService.createOrganization).not.toHaveBeenCalled();
    });

    it('should not add a second OWNER membership for the same tenant', async () => {
      userRepository.findByEmail.mockResolvedValue({
        id: 'user_1',
        tenants: [{ tenantId: 'tenant_existing' }],
      });

      await worker.process(makeJob({ attemptsStarted: 2 }));

      expect(userRepository.upsertWithTenants).toHaveBeenCalledWith(
        expect.anything(),
        JOB_DATA.email,
        expect.anything(),
        [],
        undefined,
      );
    });

    it('should refuse to resume onto somebody elses live tenant', async () => {
      (tenantsRepository.findByAlias as jest.Mock).mockResolvedValue({
        id: 'tenant_live',
        keycloakOrgId: 'kc_org_existing',
        provisioningStatus: ProvisioningStatus.READY,
      } as any);

      await expect(
        worker.process(makeJob({ attemptsStarted: 2 })),
      ).rejects.toThrow(/already belongs to a provisioned tenant/);
      expect(tenantsRepository.remove).not.toHaveBeenCalled();
    });
  });
});
