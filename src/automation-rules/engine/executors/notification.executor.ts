import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ActionExecutionResult, ActionExecutor } from './executor.interface';
import { AutomationActionJobData } from '../../queue/automation-queue.constants';
import { TemplateVariableRegistryService } from '../../../templates/services/template-variable-registry.service';
import { IOREDIS_CLIENT } from '../../../redis/redis.tokens';

/**
 * Redis channel the realtime bridge listens on.
 *
 * Must stay listed in `CrmRealtimeGateway.REDIS_CHANNELS`: a channel published to
 * but not registered there falls into `handleRedisMessage`'s default branch and
 * is dropped, which is how a notification looks delivered on the publisher's side
 * and arrives nowhere.
 */
export const AUTOMATION_NOTIFICATION_CHANNEL = 'socket:automation:notification';

/** Recipient selectors this action can actually resolve. */
const RECIPIENT_TYPES = new Set(['owner', 'specific']);

/**
 * Notify people inside the workspace from a workflow.
 *
 * Publishes on the `socket:*` Redis channel `CrmRealtimeGateway` bridges into
 * Socket.IO rooms — the seam the rest of the platform uses for asynchronous
 * notices. Only `owner` and `specific` recipients exist, because those are the
 * only audiences anything can resolve.
 *
 * Delivery is a live broadcast: the platform has no persisted notification inbox,
 * so an offline recipient will not see this later. The output reports a broadcast,
 * not a receipt — handing the notice to the bus is the only guarantee available,
 * and claiming more is a lie the step log would repeat.
 */
@Injectable()
export class InternalNotificationExecutor implements ActionExecutor {
  readonly actionType = 'internal_notification';
  private readonly logger = new Logger(InternalNotificationExecutor.name);

  constructor(
    private readonly templateEngine: TemplateVariableRegistryService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { recordId, recordType, actionConfig, tenantId, recordData } = job;

    const recipientType = actionConfig.recipientType ?? 'owner';
    if (!RECIPIENT_TYPES.has(recipientType)) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'UNSUPPORTED_RECIPIENT_TYPE',
          message:
            `recipientType "${recipientType}" is not supported. ` +
            `Use ${[...RECIPIENT_TYPES].join(' or ')}.`,
        },
      };
    }

    const recipientIds =
      recipientType === 'owner'
        ? [recordData.ownerId].filter(Boolean).map(String)
        : [actionConfig.specificUserId].filter(Boolean).map(String);

    if (recipientIds.length === 0) {
      return {
        success: false,
        retryable: false,
        error: {
          code: 'NO_RECIPIENT',
          message:
            recipientType === 'owner'
              ? `${recordType}(${recordId}) has no owner to notify`
              : 'No specificUserId configured on the notification action',
        },
      };
    }

    const title = this.templateEngine.render(
      actionConfig.title ?? 'Workflow notification',
      recordData,
      { mode: 'broad' },
    );
    const message = this.templateEngine.render(
      actionConfig.message ?? '',
      recordData,
      { mode: 'broad' },
    );

    this.logger.log(
      `[InternalNotification] tenant=${tenantId} type=${recipientType} ` +
        `recipients=${recipientIds.length} title="${title}"`,
    );

    await this.redis.publish(
      AUTOMATION_NOTIFICATION_CHANNEL,
      JSON.stringify({
        tenantId,
        recipientIds,
        title,
        message,
        source: 'automation',
        workflowId: job.workflowId,
        recordType,
        recordId,
      }),
    );

    return {
      success: true,
      output: { broadcast: true, recipientType, recipientIds },
    };
  }
}
