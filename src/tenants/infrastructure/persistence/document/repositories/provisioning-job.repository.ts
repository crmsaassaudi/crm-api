import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ProvisioningJobDocument,
  ProvisioningJobSchemaClass,
} from '../entities/provisioning-job.schema';

@Injectable()
export class ProvisioningJobRepository {
  private readonly logger = new Logger(ProvisioningJobRepository.name);

  constructor(
    @InjectModel(ProvisioningJobSchemaClass.name)
    private readonly model: Model<ProvisioningJobDocument>,
  ) {}

  async create(data: {
    provisioningId: string;
    source: 'PLG' | 'SLG';
    companyName: string;
    adminEmail: string;
    alias?: string;
  }): Promise<void> {
    await this.model.create({
      ...data,
      status: 'QUEUED',
      events: [
        {
          status: 'QUEUED',
          stepLabel: 'Job queued',
          timestamp: new Date(),
        },
      ],
    });
  }

  async updateStatus(
    provisioningId: string,
    update: {
      status: string;
      currentStep?: number;
      totalSteps?: number;
      stepLabel?: string;
      tenantId?: string;
      redirectUrl?: string;
      error?: string;
    },
  ): Promise<void> {
    const event = {
      status: update.status,
      step: update.currentStep,
      stepLabel: update.stepLabel,
      message: update.error,
      timestamp: new Date(),
    };

    await this.model.updateOne(
      { provisioningId },
      {
        $set: {
          status: update.status,
          ...(update.currentStep !== undefined
            ? { currentStep: update.currentStep }
            : {}),
          ...(update.totalSteps !== undefined
            ? { totalSteps: update.totalSteps }
            : {}),
          ...(update.stepLabel !== undefined
            ? { stepLabel: update.stepLabel }
            : {}),
          ...(update.tenantId ? { tenantId: update.tenantId } : {}),
          ...(update.redirectUrl ? { redirectUrl: update.redirectUrl } : {}),
          ...(update.error !== undefined ? { error: update.error } : {}),
        },
        $push: { events: event },
      },
    );
  }

  async findById(
    provisioningId: string,
  ): Promise<ProvisioningJobDocument | null> {
    return this.model.findOne({ provisioningId }).exec();
  }

  async findByEmail(
    adminEmail: string,
    limit = 20,
  ): Promise<ProvisioningJobDocument[]> {
    return this.model
      .find({ adminEmail })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }
}
