import { Test, TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';

import { TenantCreatedListener } from './tenant-created.listener';
import { TenantCreatedEvent } from '../events/tenant-created.event';
import { TenantSettingsSeedingService } from '../../crm-settings/tenant-settings-seeding.service';
import { SampleDataSeederService } from '../services/sample-data-seeder.service';
import { SystemRolesSeederService } from '../../common/permissions/system-roles-seeder.service';
import { AssignmentSeederService } from '../../assignment/assignment-seeder.service';
import { OrgUnitsService } from '../../org-units/org-units.service';
import { GroupsService } from '../../groups/groups.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';

/**
 * The wizard asks for headcount and use case and then decides nothing with
 * them — both answers used to be discarded, so a solo founder and a 300-person
 * company were handed the same single-unit tree.
 */
describe('TenantCreatedListener — org baseline', () => {
  let listener: TenantCreatedListener;
  let orgUnits: any;
  let groups: any;

  const HQ = { id: 'hq_1', code: 'HQ', name: 'Acme' };

  const event = (
    overrides: Partial<{ teamSize: string; useCase: string }> = {},
  ) =>
    new TenantCreatedEvent(
      'tenant_1',
      'Acme',
      'owner@acme.test',
      'owner_1',
      overrides.useCase,
      overrides.teamSize,
    );

  const createdUnitCodes = () =>
    orgUnits.create.mock.calls
      .map(([, dto]: [string, { code?: string }]) => dto.code)
      .filter((code: string | undefined) => code !== 'HQ');

  beforeEach(async () => {
    orgUnits = {
      // First call resolves the roots lookup; the seeder adopts HQ.
      findAll: jest.fn().mockResolvedValue([HQ]),
      create: jest
        .fn()
        .mockImplementation((_tenantId, dto) =>
          Promise.resolve({ id: `unit_${dto.code}`, ...dto }),
        ),
    };
    groups = {
      findAll: jest.fn().mockResolvedValue([{ name: 'Owner' }]),
      create: jest.fn().mockResolvedValue({ id: 'group_1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantCreatedListener,
        {
          provide: TenantSettingsSeedingService,
          useValue: { seedDefaults: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SampleDataSeederService,
          useValue: { seed: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SystemRolesSeederService,
          useValue: { ensureForTenant: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: AssignmentSeederService,
          useValue: { seedForTenant: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: OrgUnitsService, useValue: orgUnits },
        { provide: GroupsService, useValue: groups },
        {
          provide: UserRepository,
          useValue: {
            findById: jest.fn().mockResolvedValue({
              id: 'owner_1',
              tenants: [{ tenantId: 'tenant_1', orgUnitId: 'hq_1' }],
            }),
            update: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ClsService,
          useValue: { runWith: (_: any, fn: any) => fn() },
        },
      ],
    }).compile();

    listener = module.get(TenantCreatedListener);
    jest.spyOn(listener['logger'], 'log').mockImplementation();
    jest.spyOn(listener['logger'], 'error').mockImplementation();
  });

  it('should build no departments for a team of ten or fewer', async () => {
    await listener.handleTenantCreatedEvent(
      event({ teamSize: '1-10', useCase: 'all' }),
    );

    expect(createdUnitCodes()).toEqual([]);
  });

  it('should build only what the use case implies for a small team', async () => {
    await listener.handleTenantCreatedEvent(
      event({ teamSize: '11-50', useCase: 'sales_pipeline' }),
    );

    expect(createdUnitCodes()).toEqual(['SALES']);
  });

  it('should add Operations once the company is large enough to need one', async () => {
    await listener.handleTenantCreatedEvent(
      event({ teamSize: '51-200', useCase: 'all' }),
    );

    expect(createdUnitCodes()).toEqual([
      'SALES',
      'SUPPORT',
      'MARKETING',
      'OPERATIONS',
    ]);
  });

  it('should build nothing when the wizard was skipped', async () => {
    await listener.handleTenantCreatedEvent(event());

    expect(createdUnitCodes()).toEqual([]);
  });

  it('should not duplicate a department a replay already created', async () => {
    orgUnits.findAll.mockResolvedValue([
      HQ,
      { id: 'unit_sales', code: 'SALES', name: 'Sales — renamed' },
    ]);

    await listener.handleTenantCreatedEvent(
      event({ teamSize: '11-50', useCase: 'all' }),
    );

    expect(createdUnitCodes()).toEqual(['SUPPORT', 'MARKETING']);
  });
});
