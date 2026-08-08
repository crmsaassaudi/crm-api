import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CampaignSchemaClass } from '../../campaigns/campaign.schema';
import { AutomationWorkflowSchemaClass } from '../../automation-rules/infrastructure/persistence/document/entities/automation-workflow.schema';

export interface DeletabilityCheck {
  deletable: boolean;
  warning?: string;
}

/**
 * "Is this template safe to delete?" — modeled on
 * `ChannelConfigService.softDelete` (hard-block active references, soft-warn
 * on draft-only ones) and `OrgUnitsService.remove` (cheap count-based guard).
 *
 * Reads the Campaign and AutomationWorkflow collections directly via their own
 * `@InjectModel` rather than importing CampaignsModule/AutomationRulesModule —
 * CampaignsModule already imports ChannelsModule, so importing it back here
 * would close a require cycle. This is the same "read-only cross-cutting
 * check" shape as `tag-usage.service.ts`.
 */
@Injectable()
export class TemplateReferencesService {
  constructor(
    @InjectModel(CampaignSchemaClass.name)
    private readonly campaignModel: Model<CampaignSchemaClass>,
    @InjectModel(AutomationWorkflowSchemaClass.name)
    private readonly workflowModel: Model<AutomationWorkflowSchemaClass>,
  ) {}

  async assertDeletable(
    tenantId: string,
    templateId: string,
  ): Promise<DeletabilityCheck> {
    const activeCampaignCount = await this.campaignModel.countDocuments({
      tenantId,
      'channelConfig.templateId': templateId,
      status: { $in: ['scheduled', 'sending'] },
    });
    if (activeCampaignCount > 0) {
      throw new ConflictException(
        `Cannot delete: this template is used by ${activeCampaignCount} scheduled or in-flight campaign(s). ` +
          `Cancel or reschedule those campaigns first.`,
      );
    }

    const activeWorkflows = await this.workflowModel
      .find({ tenantId, status: 'active' }, { name: 1, publishedNodes: 1 })
      .lean()
      .exec();
    const referencingActiveWorkflows = activeWorkflows.filter((w: any) =>
      (w.publishedNodes ?? []).some(
        (node: any) => node.type === 'action' && node.config?.templateId === templateId,
      ),
    );
    if (referencingActiveWorkflows.length > 0) {
      const names = referencingActiveWorkflows.map((w: any) => w.name).join(', ');
      throw new ConflictException(
        `Cannot delete: this template is used by active automation(s): ${names}. ` +
          `Update or deactivate those workflows first.`,
      );
    }

    const draftWorkflows = await this.workflowModel
      .find({ tenantId, status: 'draft' }, { name: 1, nodes: 1 })
      .lean()
      .exec();
    const referencingDraftWorkflows = draftWorkflows.filter((w: any) =>
      (w.nodes ?? []).some(
        (node: any) => node.type === 'action' && node.config?.templateId === templateId,
      ),
    );

    return {
      deletable: true,
      warning:
        referencingDraftWorkflows.length > 0
          ? `Note: ${referencingDraftWorkflows.length} draft automation(s) reference this template. They will need to be updated before publishing.`
          : undefined,
    };
  }
}
