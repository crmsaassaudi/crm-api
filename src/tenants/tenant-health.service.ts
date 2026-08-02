import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { UserRepository } from '../users/infrastructure/persistence/user.repository';
import { OrgUnitsService } from '../org-units/org-units.service';
import { CustomRolesService } from '../common/permissions/custom-roles.service';
import { isDataScope } from '../common/permissions/data-scope.enum';

export interface TenantHealthFinding {
  /** Stable id, so the UI can attach its own copy and link. */
  code: string;
  severity: 'blocking' | 'warning';
  /** How many things are affected; 0 means the check passed. */
  count: number;
  /** Where an admin goes to fix it. */
  settingsPath: string;
}

/**
 * Why a working tenant might still look broken.
 *
 * Every check here describes the same failure shape: a configuration that is
 * individually valid, silently produces an empty screen, and reports no error
 * anywhere. That combination is what made a freshly onboarded workspace look
 * broken — permissions pass, the list renders, and there is nothing in it.
 *
 * Deliberately read-only and advisory. Nothing here changes access; it only
 * surfaces the state an admin would otherwise have to infer from a support
 * ticket.
 */
@Injectable()
export class TenantHealthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly orgUnits: OrgUnitsService,
    private readonly customRoles: CustomRolesService,
    private readonly cls: ClsService,
  ) {}

  async check(): Promise<{
    healthy: boolean;
    findings: TenantHealthFinding[];
  }> {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) return { healthy: true, findings: [] };

    const [memberships, units, roles] = await Promise.all([
      this.userRepository.countIncompleteMemberships(tenantId),
      this.orgUnits.findAll(tenantId),
      this.customRoles.findAll(tenantId),
    ]);

    // A role with no scope floors to SELF, so its holders see only what they
    // personally own — which for a new member is nothing.
    const scopelessRoles = roles.filter(
      (role) => !isDataScope((role as { dataScope?: unknown }).dataScope),
    ).length;

    const candidates: TenantHealthFinding[] = [
      {
        code: 'members_without_org_unit',
        severity: 'blocking',
        count: memberships.withoutOrgUnit,
        settingsPath: '/settings/users',
      },
      {
        code: 'members_without_role',
        severity: 'blocking',
        count: memberships.withoutRole,
        settingsPath: '/settings/users',
      },
      {
        code: 'roles_without_data_scope',
        severity: 'warning',
        count: scopelessRoles,
        settingsPath: '/settings/roles',
      },
      {
        // Only the seeded headquarters exists. Not wrong — a ten-person company
        // needs nothing else — but every ORG_UNIT scope then covers the whole
        // tenant, which is worth saying out loud before someone relies on it
        // to separate two teams.
        code: 'org_tree_not_built',
        severity: 'warning',
        count: units.length <= 1 ? 1 : 0,
        settingsPath: '/settings/org-units',
      },
    ];
    const findings = candidates.filter((finding) => finding.count > 0);

    return {
      healthy: !findings.some((finding) => finding.severity === 'blocking'),
      findings,
    };
  }
}
