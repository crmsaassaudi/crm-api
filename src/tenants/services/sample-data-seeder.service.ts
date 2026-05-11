import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

/**
 * Seeds sample CRM data (Contacts, Accounts, Deals) for a newly provisioned tenant.
 *
 * Data is tailored to the user's selected use case (onboardingGoal) so they
 * immediately see relevant examples — shortening Time-to-Value.
 *
 * Supported use cases:
 *  - sales_pipeline   → Focus on Deals + Accounts + qualified Contacts
 *  - customer_support → Focus on Contacts + Tickets (basic Accounts)
 *  - marketing        → Focus on Contacts with varied lifecycle stages
 *  - all              → Full set across all entities
 */
@Injectable()
export class SampleDataSeederService {
  private readonly logger = new Logger(SampleDataSeederService.name);

  constructor(
    @InjectModel('ContactSchemaClass')
    private readonly contactModel: Model<any>,
    @InjectModel('AccountSchemaClass')
    private readonly accountModel: Model<any>,
    @InjectModel('DealSchemaClass') private readonly dealModel: Model<any>,
    @InjectModel('DealStageSchemaClass')
    private readonly dealStageModel: Model<any>,
  ) {}

  /**
   * Seeds sample data for a tenant based on their onboarding goal.
   * Skips if the tenant already has data (idempotent).
   */
  async seed(
    tenantId: string,
    ownerId: string,
    useCase?: string,
  ): Promise<void> {
    // Guard: Don't seed if tenant already has contacts
    const existingCount = await this.contactModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
    });
    if (existingCount > 0) {
      this.logger.log(
        `[SampleData] Tenant ${tenantId} already has data, skipping`,
      );
      return;
    }

    const seedContext = {
      tenantId: new Types.ObjectId(tenantId),
      ownerId: new Types.ObjectId(ownerId),
    };

    try {
      switch (useCase) {
        case 'sales_pipeline':
          await this.seedSalesPipeline(seedContext);
          break;
        case 'customer_support':
          await this.seedCustomerSupport(seedContext);
          break;
        case 'marketing':
          await this.seedMarketing(seedContext);
          break;
        case 'all':
        default:
          await this.seedSalesPipeline(seedContext);
          await this.seedCustomerSupport(seedContext);
          break;
      }

      this.logger.log(
        `[SampleData] Seeded "${useCase || 'all'}" data for tenant ${tenantId}`,
      );
    } catch (err) {
      this.logger.error(
        `[SampleData] Failed to seed for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`,
      );
      // Non-fatal — tenant is still usable without sample data
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sales Pipeline focus
  // ─────────────────────────────────────────────────────────────────────────────

  private async seedSalesPipeline(context: SeedContext): Promise<void> {
    const audit = this.auditFields(context);
    const defaultStageId = await this.getDefaultDealStageId(context);

    // Sample Accounts
    const accounts = await this.accountModel.insertMany([
      {
        ...audit,
        name: 'Acme Corporation',
        industry: 'Technology',
        website: 'https://acme.example.com',
        phones: ['+1-555-100-2000'],
      },
      {
        ...audit,
        name: 'GlobalTech Solutions',
        industry: 'Finance',
        website: 'https://globaltech.example.com',
        phones: ['+1-555-200-3000'],
      },
      {
        ...audit,
        name: 'Sunrise Retail',
        industry: 'Retail',
        website: 'https://sunrise.example.com',
      },
    ]);

    // Sample Contacts
    const contacts = await this.contactModel.insertMany([
      {
        ...audit,
        firstName: 'Sarah',
        lastName: 'Johnson',
        emails: ['sarah@acme.example.com'],
        phones: ['+1-555-101-0001'],
        title: 'VP of Engineering',
        accountId: accounts[0]._id,
      },
      {
        ...audit,
        firstName: 'Michael',
        lastName: 'Chen',
        emails: ['michael.chen@globaltech.example.com'],
        phones: ['+1-555-201-0002'],
        title: 'CTO',
        accountId: accounts[1]._id,
      },
      {
        ...audit,
        firstName: 'Emily',
        lastName: 'Davis',
        emails: ['emily@sunrise.example.com'],
        title: 'Procurement Manager',
        accountId: accounts[2]._id,
      },
    ]);

    // Sample Deals
    await this.dealModel.insertMany([
      {
        ...audit,
        title: 'Acme CRM Enterprise License',
        name: 'Acme CRM Enterprise License',
        pipeline: 'default',
        stageId: defaultStageId,
        value: 45000,
        currency: 'USD',
        probability: 70,
        contactIds: [contacts[0]._id],
        accountId: accounts[0]._id,
        accountName: accounts[0].name,
        closeDate: new Date(Date.now() + 14 * 86_400_000),
      },
      {
        ...audit,
        title: 'GlobalTech Annual Subscription',
        name: 'GlobalTech Annual Subscription',
        pipeline: 'default',
        stageId: defaultStageId,
        value: 120000,
        currency: 'USD',
        probability: 40,
        contactIds: [contacts[1]._id],
        accountId: accounts[1]._id,
        accountName: accounts[1].name,
        closeDate: new Date(Date.now() + 30 * 86_400_000),
      },
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Customer Support focus
  // ─────────────────────────────────────────────────────────────────────────────

  private async seedCustomerSupport(context: SeedContext): Promise<void> {
    const audit = this.auditFields(context);

    const account = await this.accountModel.create({
      ...audit,
      name: 'VIP Customer Inc.',
      industry: 'Healthcare',
      website: 'https://vip-customer.example.com',
    });

    await this.contactModel.insertMany([
      {
        ...audit,
        firstName: 'Anna',
        lastName: 'Smith',
        emails: ['anna@vip-customer.example.com'],
        phones: ['+1-555-300-0001'],
        title: 'IT Manager',
        accountId: account._id,
      },
      {
        ...audit,
        firstName: 'James',
        lastName: 'Wilson',
        emails: ['james@vip-customer.example.com'],
        title: 'Support Lead',
        accountId: account._id,
      },
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Marketing focus
  // ─────────────────────────────────────────────────────────────────────────────

  private async seedMarketing(context: SeedContext): Promise<void> {
    const audit = this.auditFields(context);

    await this.contactModel.insertMany([
      {
        ...audit,
        firstName: 'Lisa',
        lastName: 'Wang',
        emails: ['lisa@marketing-demo.example.com'],
        title: 'Marketing Director',
      },
      {
        ...audit,
        firstName: 'David',
        lastName: 'Park',
        emails: ['david@marketing-demo.example.com'],
        title: 'Growth Manager',
      },
      {
        ...audit,
        firstName: 'Maria',
        lastName: 'Garcia',
        emails: ['maria@marketing-demo.example.com'],
        title: 'Content Strategist',
      },
    ]);
  }

  private auditFields(context: SeedContext) {
    return {
      tenantId: context.tenantId,
      ownerId: context.ownerId,
      createdById: context.ownerId,
      updatedById: context.ownerId,
    };
  }

  private async getDefaultDealStageId(
    context: SeedContext,
  ): Promise<Types.ObjectId> {
    const existing = await this.dealStageModel
      .findOne({
        tenantId: context.tenantId,
        pipelineId: 'default',
        apiName: 'qualification',
      })
      .exec();

    if (existing?._id) {
      return existing._id;
    }

    const stage = await this.dealStageModel.create({
      tenantId: context.tenantId,
      label: 'Qualification',
      apiName: 'qualification',
      color: '#3b82f6',
      sortOrder: 1,
      pipelineId: 'default',
      probability: 10,
      isDefault: true,
    });

    return stage._id;
  }
}

type SeedContext = {
  tenantId: Types.ObjectId;
  ownerId: Types.ObjectId;
};
