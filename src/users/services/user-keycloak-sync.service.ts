import { Injectable, Logger } from '@nestjs/common';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';

export interface ProvisionUserInput {
  email: string;
  fullName: string;
  /** Required only for SLG flow when caller already has a password. */
  password?: string;
  /** Keycloak organization to attach the user to. */
  organizationId: string;
  /** Whether to issue a Keycloak reset-password action email. */
  sendResetPasswordEmail?: boolean;
}

export interface ProvisionUserResult {
  keycloakUserId: string;
  createdByThisCall: boolean;
}

/**
 * Thin wrapper around `KeycloakAdminService` that bundles the standard
 * provisioning pattern used in 4+ places in `users.service.ts`:
 *
 *   1. find-or-create KC user
 *   2. add to organization
 *   3. (optional) trigger reset-password email
 *
 * Extracting the bundle into one method gives `users.service` a single
 * call site to migrate per flow (invite / create / SLG / re-invite),
 * which we can do incrementally in follow-up sprints without one giant
 * 200-line refactor.
 *
 * Companion to the audit finding (2026-05-28) that flagged
 * `users.service.ts` as 803 LOC with duplicate KC orchestration.
 */
@Injectable()
export class UserKeycloakSyncService {
  private readonly logger = new Logger(UserKeycloakSyncService.name);

  constructor(private readonly kcAdmin: KeycloakAdminService) {}

  async provisionUser(input: ProvisionUserInput): Promise<ProvisionUserResult> {
    let kcUser = await this.kcAdmin.findUserByEmail(input.email);
    let createdByThisCall = false;

    if (!kcUser) {
      const password = input.password ?? this.generateTempPassword();
      kcUser = await this.kcAdmin.createUser(
        input.email,
        password,
        input.fullName,
      );
      createdByThisCall = true;
      this.logger.log(`[UserKcSync] Created KC user ${kcUser.id}`);
    } else {
      this.logger.log(`[UserKcSync] Reusing existing KC user ${kcUser.id}`);
    }

    await this.kcAdmin.addUserToOrganization(input.organizationId, kcUser.id);

    if (input.sendResetPasswordEmail) {
      await this.kcAdmin.resetPassword(kcUser.id);
    }

    return { keycloakUserId: kcUser.id, createdByThisCall };
  }

  /**
   * Rollback helper. Pair with the boolean returned from provisionUser:
   * call only when `createdByThisCall === true` so we never delete a
   * user account that already existed before our call.
   */
  async rollbackUser(keycloakUserId: string): Promise<void> {
    try {
      await this.kcAdmin.deleteUser(keycloakUserId);
      this.logger.warn(
        `[UserKcSync] Rolled back KC user ${keycloakUserId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[UserKcSync] Rollback failed for ${keycloakUserId}: ${err?.message ?? err}`,
      );
    }
  }

  private generateTempPassword(): string {
    // Same shape used by tenant-provisioning.worker.ts.
    const random = Math.random().toString(36).slice(-12);
    return `Temp${random}!`;
  }
}
