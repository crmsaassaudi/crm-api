import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';

/**
 * Orphan Cleanup Cron
 *
 * Runs every 6 hours to find and clean up user accounts that started
 * the PLG onboarding flow but never completed it (no tenant was created).
 *
 * Criteria:
 *  - onboardingStatus = 'INCOMPLETE_ONBOARDING'
 *  - createdAt > 24 hours ago
 *
 * Actions:
 *  1. Delete the Keycloak user (if exists)
 *  2. Delete the MongoDB user record
 */
@Injectable()
export class OrphanCleanupCron {
  private readonly logger = new Logger(OrphanCleanupCron.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly keycloakAdminService: KeycloakAdminService,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleOrphanCleanup(): Promise<void> {
    this.logger.log(
      '[OrphanCleanup] Starting scan for incomplete onboarding accounts…',
    );

    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
    let cleanedCount = 0;
    let errorCount = 0;

    try {
      // Find all incomplete users older than 24h
      // Using direct repo query since we need a custom filter
      const incompleteUsers = await this.findIncompleteUsers(cutoffDate);

      if (incompleteUsers.length === 0) {
        this.logger.log(
          '[OrphanCleanup] No orphan accounts found. All clean ✓',
        );
        return;
      }

      this.logger.log(
        `[OrphanCleanup] Found ${incompleteUsers.length} orphan account(s) to clean up`,
      );

      for (const user of incompleteUsers) {
        try {
          // 1. Delete Keycloak user if they have a keycloakId
          if (user.keycloakId) {
            await this.keycloakAdminService
              .deleteUser(user.keycloakId)
              .catch((e) => {
                // KC user may already be deleted — non-fatal
                this.logger.warn(
                  `[OrphanCleanup] KC delete for ${user.email} failed (may not exist): ${e.message}`,
                );
              });
          }

          // 2. Delete MongoDB user
          await this.userRepository.remove(user.id);

          cleanedCount++;
          this.logger.log(
            `[OrphanCleanup] Cleaned up: ${user.email} (userId=${user.id}, age=${this.getAge(user.createdAt)})`,
          );
        } catch (err) {
          errorCount++;
          this.logger.error(
            `[OrphanCleanup] Failed to clean ${user.email}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `[OrphanCleanup] Scan failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    this.logger.log(
      `[OrphanCleanup] Complete — cleaned: ${cleanedCount}, errors: ${errorCount}`,
    );
  }

  /**
   * Find users with INCOMPLETE_ONBOARDING status created before the cutoff date.
   *
   * Note: This is a direct query because the UserRepository doesn't expose
   * a filter for onboardingStatus. In a future refactor, this should be moved
   * to a proper repository method.
   */
  private async findIncompleteUsers(
    cutoffDate: Date,
  ): Promise<
    Array<{ id: string; email: string; keycloakId?: string; createdAt: Date }>
  > {
    // We use the repository's findManyWithPagination with a custom filter
    // or fallback to a more specific approach
    const result = await this.userRepository.findManyWithPagination({
      filterOptions: {
        onboardingStatus: 'INCOMPLETE_ONBOARDING',
        createdBefore: cutoffDate,
      } as any,
      paginationOptions: { page: 1, limit: 100 },
    });

    return result.data.map((u) => ({
      id: u.id as string,
      email: u.email || '',
      keycloakId: u.keycloakId || undefined,
      createdAt: u.createdAt,
    }));
  }

  private getAge(createdAt: Date): string {
    const hours = Math.round((Date.now() - createdAt.getTime()) / 3_600_000);
    return `${hours}h`;
  }
}
