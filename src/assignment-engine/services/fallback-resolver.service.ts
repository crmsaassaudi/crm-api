import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AssignmentSettingSchemaClass } from '../entities/assignment-setting.schema';

/**
 * FallbackResolverService — determines the backup owner when no candidate
 * survives the capacity/skills/hours filtering pipeline.
 *
 * Resolution order:
 *   1. fallbackOwnerId from module settings → assign
 *   2. Return null → entity goes to "Unassigned" queue
 */
@Injectable()
export class FallbackResolverService {
  private readonly logger = new Logger(FallbackResolverService.name);

  constructor(
    @InjectModel(AssignmentSettingSchemaClass.name)
    private readonly settingModel: Model<AssignmentSettingSchemaClass>,
  ) {}

  async resolve(tenantId: string, module: string): Promise<string | null> {
    const setting = await this.settingModel
      .findOne({ tenantId, module })
      .lean()
      .exec();

    if (setting?.fallbackOwnerId) {
      this.logger.log(
        `Fallback: assigning ${module} to fallbackOwnerId=${setting.fallbackOwnerId} for tenant ${tenantId}`,
      );
      return setting.fallbackOwnerId.toString();
    }

    this.logger.warn(
      `Fallback: no fallback owner configured for ${module} (tenant ${tenantId}) — entity will be unassigned`,
    );
    return null;
  }
}
