import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UserRepository } from '../../users/infrastructure/persistence/user.repository';
import { KeycloakAdminService } from '../../auth/services/keycloak-admin.service';
import { RedisLockService } from '../../redis/redis-lock.service';

/**
 * Orphan Cleanup Cron
 *
 * Runs every 6 hours to find and clean up user accounts that started
 * the PLG onboarding flow but never completed it (no tenant was created).
 *
 * Criteria:
 *  - onboardingStatus = 'INCOMPLETE_ONBOARDING'
 *  - createdAt < 24 hours ago
 *  - no tenant membership was created
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
    private readonly lockService: RedisLockService,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleOrphanCleanup(): Promise<void> {
    try {
      await this.lockService.acquire(
        'cron:tenant-onboarding:orphan-cleanup',
        30 * 60 * 1000,
        () => this.runCleanup(),
        0,
        1,
      );
    } catch (err: any) {
      if (err?.message?.includes('Could not acquire lock')) {
        this.logger.debug(
          '[OrphanCleanup] Skipped; another worker owns this tick',
        );
        return;
      }
      throw err;
    }
  }

  private async runCleanup(): Promise<void> {
    this.logger.log(
      '[OrphanCleanup] Starting scan for incomplete onboarding accounts…',
    );

    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
    let cleanedCount = 0;
    let errorCount = 0;

    try {
      const incompleteUsers =
        await this.userRepository.findIncompleteOnboardingBefore(
          cutoffDate,
          100,
        );

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

  private getAge(createdAt: Date): string {
    const hours = Math.round((Date.now() - createdAt.getTime()) / 3_600_000);
    return `${hours}h`;
  }
}
