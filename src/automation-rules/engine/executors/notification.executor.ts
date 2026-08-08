import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ActionExecutionResult, ActionExecutor } from './executor.interface';
import { AutomationActionJobData } from '../../queue/automation-queue.constants';
import { TemplateVariableRegistryService } from '../../../templates/services/template-variable-registry.service';
import { IOREDIS_CLIENT } from '../../../redis/redis.tokens';

export const AUTOMATION_NOTIFICATION_CHANNEL = 'socket:automation:notification';

const RECIPIENT_TYPES = new Set(['owner', 'specific']);

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
