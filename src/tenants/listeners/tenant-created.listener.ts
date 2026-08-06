import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { TenantCreatedEvent } from '../events/tenant-created.event';
import { TenantSettingsSeedingService } from '../../crm-settings/tenant-settings-seeding.service';
import { DealPipelineSeederService } from '../../deal-settings/deal-pipeline-seeder.service';
import { SampleDataSeederService } from '../services/sample-data-seeder.service';
import { SystemRolesSeederService } from '../../common/permissions/system-roles-seeder.service';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { AssignmentSeederService } from '../../assignment/assignment-seeder.service';
import { OrgUnitsService } from '../../org-units/org-units.service';
import { GroupsService } from '../../groups/groups.service';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';

/** Stable code for the seeded root unit, so a replay can recognise its own work. */
const HEADQUARTERS_CODE = 'HQ';
const OWNER_GROUP_NAME = 'Owner';

/** A department the seeder may create under headquarters. */
interface DepartmentBlueprint {
  code: string;
  name: string;
}

const SALES: DepartmentBlueprint = { code: 'SALES', name: 'Sales' };
const SUPPORT: DepartmentBlueprint = { code: 'SUPPORT', name: 'Support' };
const MARKETING: DepartmentBlueprint = { code: 'MARKETING', name: 'Marketing' };
const OPERATIONS: DepartmentBlueprint = {
  code: 'OPERATIONS',
  name: 'Operations',
};

/** Which departments the chosen use case implies. */
const DEPARTMENTS_BY_USE_CASE: Record<string, DepartmentBlueprint[]> = {
  sales_pipeline: [SALES],
  customer_support: [SUPPORT],
  marketing: [MARKETING],
  all: [SALES, SUPPORT, MARKETING],
};

/**
 * The org tree the onboarding answers imply.
 *
 * Two questions, two jobs. Headcount decides whether a tree is worth building
 * at all — under ten people every department would hold one person, and an
 * ORG_UNIT-scoped role in a tree like that hides colleagues from each other for
 * no reason. Use case decides which departments, because those are the modules
 * they said they came for.
 *
 * Above fifty, Operations is added regardless of use case: at that size there
 * is someone doing admin work who belongs in neither Sales nor Support, and
 * leaving them in headquarters makes the root unit a dumping ground.
 *
 * An unrecognised or absent answer yields no departments. Seeding a tree
 * nobody asked for is the more expensive mistake: an empty tenant can add
 * units in one screen, while a wrong tree has to be dismantled after records
 * have already been filed into it.
 */
function planDepartments(
  teamSize: string | undefined,
  useCase: string | undefined,
): DepartmentBlueprint[] {
  if (!teamSize || teamSize === '1-10') return [];

  const base = DEPARTMENTS_BY_USE_CASE[useCase ?? ''] ?? [];
  if (base.length === 0) return [];

  const needsOperations = teamSize === '51-200' || teamSize === '200+';
  return needsOperations ? [...base, OPERATIONS] : base;
}

@Injectable()
export class TenantCreatedListener {
  private readonly logger = new Logger(TenantCreatedListener.name);

  constructor(
    private readonly settingsSeeding: TenantSettingsSeedingService,
    private readonly dealPipelineSeeder: DealPipelineSeederService,
    private readonly sampleDataSeeder: SampleDataSeederService,
    private readonly systemRolesSeeder: SystemRolesSeederService,
    private readonly assignmentSeeder: AssignmentSeederService,
    private readonly orgUnitsService: OrgUnitsService,
    private readonly groupsService: GroupsService,
    private readonly userRepository: UserRepository,
    private readonly cls: ClsService,
  ) {}

  @OnEvent('tenant.created', { async: true })
  async handleTenantCreatedEvent(event: TenantCreatedEvent): Promise<void> {
    return runWithTenantContext(this.cls, event.tenantId, async () => {
      this.logger.log(
        `Tenant created: ${event.companyName} (${event.tenantId}) with admin ${event.adminEmail}`,
      );

      // Pipelines, lifecycle stages, data-visibility defaults, etc.
      await this.step('CRM settings', event, () =>
        this.settingsSeeding.seedDefaults(event.tenantId),
      );

      // The workspace's first pipeline, its stages and its acquisition sources.
      // Real documents in `deal_pipelines`/`deal_stages`, because that is what a
      // deal references — a settings blob left every new tenant with a pipeline
      // no deal could point at.
      await this.step('deal pipeline', event, () =>
        this.dealPipelineSeeder.seedForTenant(event.tenantId),
      );

      // Assignment settings live in their own collection, one row per
      // objectType. Seeded here so a new workspace has a routing configuration
      // rather than falling through to the hard-coded defaults.
      await this.step('assignment settings', event, () =>
        this.assignmentSeeder.seedForTenant(event.tenantId),
      );

      // Materialise the built-in roles so the workspace is never role-less.
      await this.step('system roles', event, () =>
        this.systemRolesSeeder.ensureForTenant(event.tenantId),
      );

      // Root org unit + owner group — see seedOrgBaseline.
      await this.step('default org unit/group', event, () =>
        this.seedOrgBaseline(event),
      );

      if (event.ownerId) {
        await this.step('sample data', event, () =>
          this.sampleDataSeeder.seed(
            event.tenantId,
            event.ownerId!,
            event.onboardingGoal,
          ),
        );
      }
    });
  }

  /**
   * Run one seeding step, logging and swallowing failure.
   *
   * Two reasons nothing here may throw. The emitter is fire-and-forget
   * (`emit`, not `emitAsync`), so an escaping rejection is unhandled and
   * invisible; and provisioning has already committed by the time this runs, so
   * failing loudly would not undo anything — it would only skip the steps that
   * come after. Every step is idempotent, so replaying `tenant.created` repairs
   * whatever failed.
   */
  private async step(
    label: string,
    event: TenantCreatedEvent,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      this.logger.error(
        `Failed to seed ${label} for tenant ${event.tenantId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Root org unit + owner group.
   *
   * Org-unit and group scoped features — data visibility, sharing rules,
   * channel support pools — resolve against these, so a tenant without them
   * starts life one manual setup step away from any of that working.
   *
   * Idempotent, like every other seeder on this event: the provisioning retry
   * path replays `tenant.created`, so each step has to converge rather than
   * duplicate.
   */
  private async seedOrgBaseline(event: TenantCreatedEvent): Promise<void> {
    const roots = await this.orgUnitsService.findAll(event.tenantId, {
      parentId: null,
    });
    const headquarters =
      roots[0] ??
      (await this.orgUnitsService.create(event.tenantId, {
        name: event.companyName,
        code: HEADQUARTERS_CODE,
        managerId: event.ownerId ?? null,
      }));

    await this.seedDepartments(event, headquarters.id);

    if (!event.ownerId) return;

    // Placement is per-membership, so this only ever touches THIS tenant's
    // membership — an owner who also belongs to other workspaces keeps their
    // placement in each of them.
    const owner = await this.userRepository.findById(event.ownerId);
    const membership = owner?.tenants?.find(
      (row) => String(row.tenantId) === String(event.tenantId),
    );
    if (owner && membership && !membership.orgUnitId) {
      await this.userRepository.update(event.ownerId, {
        tenants: owner.tenants.map((row) =>
          String(row.tenantId) === String(event.tenantId)
            ? { ...row, orgUnitId: headquarters.id }
            : row,
        ),
      });
    }

    // Deliberately role-less: this is a container the tenant can hang roles or
    // a channel support pool off later. Passing roleIds here would reach
    // GroupsService's grant check, which needs an acting principal in CLS —
    // there is none on an event handler.
    const groups = await this.groupsService.findAll({
      search: OWNER_GROUP_NAME,
    });
    if (!groups.some((group) => group.name === OWNER_GROUP_NAME)) {
      await this.groupsService.create({
        name: OWNER_GROUP_NAME,
        description: 'Default group for the tenant owner',
        memberIds: [event.ownerId],
      });
    }
  }

  /**
   * Create the departments the onboarding answers imply, under headquarters.
   *
   * Matched on `code`, never on name: a tenant is free to rename "Sales" the
   * day after signup, and a replay must recognise the renamed unit as its own
   * rather than create a second one beside it.
   */
  private async seedDepartments(
    event: TenantCreatedEvent,
    headquartersId: string,
  ): Promise<void> {
    const planned = planDepartments(event.teamSize, event.onboardingGoal);
    if (planned.length === 0) return;

    const existing = await this.orgUnitsService.findAll(event.tenantId);
    const codes = new Set(
      existing.map((unit) => unit.code).filter(Boolean) as string[],
    );

    for (const department of planned) {
      if (codes.has(department.code)) continue;
      await this.orgUnitsService.create(event.tenantId, {
        name: department.name,
        code: department.code,
        parentId: headquartersId,
      });
    }
  }
}
