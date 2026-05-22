import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiVideoJobRepository } from '../repositories/ai-video-job.repository';
import { AiVideoSettingsRepository } from '../repositories/ai-video-settings.repository';
import { AiVideoAuditLogRepository } from '../repositories/ai-video-audit-log.repository';
import { AiVideoJob } from '../domain/ai-video-job';

@Injectable()
export class AiVideoSchedulerService {
  private readonly logger = new Logger(AiVideoSchedulerService.name);
  private isProcessing = false;

  constructor(
    private readonly jobRepository: AiVideoJobRepository,
    private readonly settingsRepository: AiVideoSettingsRepository,
    private readonly auditLogRepository: AiVideoAuditLogRepository,
  ) {}

  /**
   * Cron: Runs every minute to auto-schedule APPROVED video jobs
   * into Golden posting slots of respective Tenants.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleAutoScheduling() {
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;

    try {
      const approvedJobs = await this.jobRepository.findApprovedJobs();
      if (!approvedJobs.length) {
        return;
      }

      this.logger.log(`Found ${approvedJobs.length} approved job(s) pending scheduling.`);

      // Group jobs by tenantId
      const jobsByTenant: Record<string, AiVideoJob[]> = {};
      for (const job of approvedJobs) {
        if (!jobsByTenant[job.tenantId]) {
          jobsByTenant[job.tenantId] = [];
        }
        jobsByTenant[job.tenantId].push(job);
      }

      const now = new Date();

      // Process scheduling for each tenant
      for (const [tenantId, jobs] of Object.entries(jobsByTenant)) {
        let settings = await this.settingsRepository.findByTenantId(tenantId);
        if (!settings) {
          // Fallback settings
          settings = {
            id: '',
            tenantId,
            timeSlots: ['09:00', '12:00', '20:00'],
            retainOriginalDays: 30,
            retainProcessedDays: 180,
            autoCleanupTempFiles: true,
            createdAt: now,
            updatedAt: now,
          };
        }

        const slots = settings.timeSlots.length ? settings.timeSlots : ['09:00', '12:00', '20:00'];
        // Sort time slots (e.g. "09:00", "12:00")
        slots.sort();

        // Keep track of slots booked during this run to prevent mapping multiple jobs to the same slot
        const temporaryBookedSlots = new Set<number>();

        for (const job of jobs) {
          const scheduledDate = await this.findNextAvailableSlot(
            tenantId,
            slots,
            now,
            temporaryBookedSlots,
          );

          if (scheduledDate) {
            // Update job status to SCHEDULED
            await this.jobRepository.updateStatus(job.id, 'SCHEDULED', {
              scheduledAt: scheduledDate,
            });

            // Record audit trail
            await this.auditLogRepository.record({
              tenantId,
              jobId: job.id,
              action: 'AUTO_SCHEDULED',
              actorType: 'system',
              oldStatus: 'APPROVED',
              newStatus: 'SCHEDULED',
              payload: {
                scheduledAt: scheduledDate.toISOString(),
                timeSlotsConfigured: slots,
              },
            });

            temporaryBookedSlots.add(scheduledDate.getTime());
            this.logger.log(
              `Scheduled Job ${job.id} for Tenant ${tenantId} at ${scheduledDate.toISOString()}`,
            );
          } else {
            this.logger.warn(`Could not find a scheduling slot for Job ${job.id}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error in handleAutoScheduling: ${error.message}`, error.stack);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Finds the next golden slot that is not yet booked in the DB or in the active session.
   */
  private async findNextAvailableSlot(
    tenantId: string,
    slots: string[],
    now: Date,
    temporaryBookedSlots: Set<number>,
  ): Promise<Date | null> {
    const maxDaysToSearch = 30; // Safety guard: look up to 30 days ahead

    for (let dayOffset = 0; dayOffset < maxDaysToSearch; dayOffset++) {
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + dayOffset);

      for (const slot of slots) {
        const [hours, minutes] = slot.split(':').map(Number);
        
        const slotDate = new Date(targetDate);
        slotDate.setHours(hours, minutes, 0, 0);

        // If the slot is in the past, skip it
        if (slotDate <= now) {
          continue;
        }

        // If already reserved in this active session run, skip it
        if (temporaryBookedSlots.has(slotDate.getTime())) {
          continue;
        }

        // Check if slot is already booked in MongoDB
        const isBooked = await this.jobRepository.isSlotBooked(tenantId, slotDate);
        if (!isBooked) {
          return slotDate;
        }
      }
    }

    return null;
  }
}
