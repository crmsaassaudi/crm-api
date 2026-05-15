import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EscalationPoliciesService } from './escalation-policies.service';
import { ESCALATION_QUEUE } from './queue/escalation-queue.constants';
import type { EscalationJobData } from './queue/escalation.processor';
import { runWithTenantContext } from '../common/tenancy/tenant-context';

/**
 * EscalationTriggerListener — listens to `sla.breached` events and
 * schedules delayed escalation jobs based on the tenant's escalation policies.
 *
 * Flow:
 *   1. SLA breach detected (frtBreached or resolutionBreached)
 *   2. Look up all enabled escalation policies for the breached SLA policy
 *   3. For each escalation policy, schedule a delayed job that fires
 *      `escalateAfter` minutes/hours later
 *   4. When the job fires, EscalationProcessor executes the actions
 *      (color_red, notify manager, reassign, etc.)
 *
 * Example configuration:
 *   - Policy A: escalateAfter=5, unit=minutes, action=color_red → red highlight
 *   - Policy B: escalateAfter=15, unit=minutes, action=notify → ping manager
 */
@Injectable()
export class EscalationTriggerListener {
  private readonly logger = new Logger(EscalationTriggerListener.name);

  constructor(
    private readonly escalationService: EscalationPoliciesService,
    @InjectQueue(ESCALATION_QUEUE)
    private readonly escalationQueue: Queue<EscalationJobData>,
    private readonly cls: ClsService,
  ) {}

  @OnEvent('sla.breached')
  async handleSlaBreached(event: {
    tenantId: string;
    conversationId: string;
    slaPolicyId: string;
    breachType: string;
    breachedAt: Date;
  }): Promise<void> {
    return runWithTenantContext(this.cls, event.tenantId, async () => {
      try {
        const allPolicies = await this.escalationService.findAll();

        // Filter policies that match the breached SLA policy
        const matchingPolicies = allPolicies.filter(
          (p) => p.enabled && p.slaId === event.slaPolicyId,
        );

        if (matchingPolicies.length === 0) {
          this.logger.debug(
            `No escalation policies for SLA ${event.slaPolicyId} — skipping`,
          );
          return;
        }

        for (const policy of matchingPolicies) {
          const delayMs = this.computeDelayMs(
            policy.escalateAfter,
            policy.escalateUnit,
          );

          const jobId = `escalation:${policy.id}:${event.conversationId}`;
          const level: 'warning' | 'breach' =
            policy.breachType === 'breach' ? 'breach' : 'warning';

          try {
            // Remove any existing job (idempotent)
            const existingJob = await this.escalationQueue.getJob(jobId);
            if (existingJob) await existingJob.remove();
          } catch {
            // Safe to ignore
          }

          await this.escalationQueue.add(
            'escalation',
            {
              tenantId: event.tenantId,
              conversationId: event.conversationId,
              escalationPolicyId: policy.id,
              level,
              actions: policy.actions,
            },
            { jobId, delay: delayMs },
          );

          this.logger.log(
            `Scheduled escalation [${policy.name}] for conversation ${event.conversationId} ` +
              `in ${policy.escalateAfter} ${policy.escalateUnit} (${level})`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to schedule escalation for conversation ${event.conversationId}: ${err.message}`,
        );
      }
    });
  }

  private computeDelayMs(value: number, unit: string): number {
    switch (unit) {
      case 'minutes':
        return value * 60 * 1000;
      case 'hours':
        return value * 60 * 60 * 1000;
      default:
        return value * 60 * 1000;
    }
  }
}
