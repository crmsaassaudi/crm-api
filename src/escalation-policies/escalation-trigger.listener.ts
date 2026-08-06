import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EscalationPoliciesService } from './escalation-policies.service';
import { ESCALATION_QUEUE } from './queue/escalation-queue.constants';
import type { EscalationJobData } from './queue/escalation.processor';
import { runWithTenantContext } from '../common/tenancy/tenant-context';
import { SlaEvents } from '../sla-policies/clock/sla-events';
import type { SlaBreachedEvent } from '../sla-policies/clock/sla-events';

/**
 * Schedules a delayed escalation job for every policy attached to a breached
 * SLA, for conversations and tickets alike.
 *
 * `SlaEvents.BREACHED` → matching escalation policies → one delayed job each,
 * firing `escalateAfter` later, which `EscalationProcessor` executes.
 *
 * The jobId is keyed on (policy, subject, metric, cycle). A `next_response`
 * SLA breaches once per customer turn, so keying on the subject alone lets each
 * new breach replace the previous one's pending escalation.
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

  @OnEvent(SlaEvents.BREACHED)
  async handleSlaBreached(event: SlaBreachedEvent): Promise<void> {
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

          const jobId =
            `escalation-${policy.id}-${event.subjectType}-${event.subjectId}` +
            `-${event.metric}-${event.cycle}`;
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
              subjectType: event.subjectType,
              subjectId: event.subjectId,
              escalationPolicyId: policy.id,
              level,
              actions: policy.actions,
            },
            { jobId, delay: delayMs },
          );

          this.logger.log(
            `Scheduled escalation [${policy.name}] for ${event.subjectType} ${event.subjectId} ` +
              `in ${policy.escalateAfter} ${policy.escalateUnit} (${level})`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `Failed to schedule escalation for ${event.subjectType} ${event.subjectId}: ${err.message}`,
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
