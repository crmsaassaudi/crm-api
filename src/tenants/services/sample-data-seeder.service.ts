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
      'tenants.tenantId': new Types.ObjectId(tenantId),
    });
    if (existingCount > 0) {
      this.logger.log(
        `[SampleData] Tenant ${tenantId} already has data, skipping`,
      );
      return;
    }

    const tenantRef = { tenantId: new Types.ObjectId(tenantId) };

    try {
      switch (useCase) {
        case 'sales_pipeline':
          await this.seedSalesPipeline(tenantRef, ownerId);
          break;
        case 'customer_support':
          await this.seedCustomerSupport(tenantRef, ownerId);
          break;
        case 'marketing':
          await this.seedMarketing(tenantRef, ownerId);
          break;
        case 'all':
        default:
          await this.seedSalesPipeline(tenantRef, ownerId);
          await this.seedCustomerSupport(tenantRef, ownerId);
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

  private async seedSalesPipeline(
    tenantRef: { tenantId: Types.ObjectId },
    ownerId: string,
  ): Promise<void> {
    const ownerOid = new Types.ObjectId(ownerId);

    // Sample Accounts
    const accounts = await this.accountModel.insertMany([
      {
        name: 'Acme Corporation',
        industry: 'Technology',
        website: 'https://acme.example.com',
        phone: '+1-555-100-2000',
        assignedTo: ownerOid,
        tenants: [tenantRef],
      },
      {
        name: 'GlobalTech Solutions',
        industry: 'Finance',
        website: 'https://globaltech.example.com',
        phone: '+1-555-200-3000',
        assignedTo: ownerOid,
        tenants: [tenantRef],
      },
      {
        name: 'Sunrise Retail',
        industry: 'Retail',
        website: 'https://sunrise.example.com',
        assignedTo: ownerOid,
        tenants: [tenantRef],
      },
    ]);

    // Sample Contacts
    const contacts = await this.contactModel.insertMany([
      {
        firstName: 'Sarah',
        lastName: 'Johnson',
        emails: [{ email: 'sarah@acme.example.com', isPrimary: true }],
        phones: [{ phone: '+1-555-101-0001', isPrimary: true }],
        title: 'VP of Engineering',
        accountId: accounts[0]._id,
        assignedTo: ownerOid,
        lifecycleStage: 'sql',
        lifecycleStatus: 'demo_scheduled',
        source: 'Website',
        tenants: [tenantRef],
      },
      {
        firstName: 'Michael',
        lastName: 'Chen',
        emails: [
          { email: 'michael.chen@globaltech.example.com', isPrimary: true },
        ],
        phones: [{ phone: '+1-555-201-0002', isPrimary: true }],
        title: 'CTO',
        accountId: accounts[1]._id,
        assignedTo: ownerOid,
        lifecycleStage: 'opportunity',
        lifecycleStatus: 'proposal_sent',
        source: 'Referral',
        tenants: [tenantRef],
      },
      {
        firstName: 'Emily',
        lastName: 'Davis',
        emails: [{ email: 'emily@sunrise.example.com', isPrimary: true }],
        title: 'Procurement Manager',
        accountId: accounts[2]._id,
        assignedTo: ownerOid,
        lifecycleStage: 'lead',
        lifecycleStatus: 'new',
        source: 'Google Ads',
        tenants: [tenantRef],
      },
    ]);

    // Sample Deals
    await this.dealModel.insertMany([
      {
        title: 'Acme CRM Enterprise License',
        amount: 45000,
        currency: 'USD',
        stage: 'negotiation',
        probability: 70,
        contactId: contacts[0]._id,
        accountId: accounts[0]._id,
        assignedTo: ownerOid,
        expectedCloseDate: new Date(Date.now() + 14 * 86_400_000),
        tenants: [tenantRef],
      },
      {
        title: 'GlobalTech Annual Subscription',
        amount: 120000,
        currency: 'USD',
        stage: 'proposal',
        probability: 40,
        contactId: contacts[1]._id,
        accountId: accounts[1]._id,
        assignedTo: ownerOid,
        expectedCloseDate: new Date(Date.now() + 30 * 86_400_000),
        tenants: [tenantRef],
      },
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Customer Support focus
  // ─────────────────────────────────────────────────────────────────────────────

  private async seedCustomerSupport(
    tenantRef: { tenantId: Types.ObjectId },
    ownerId: string,
  ): Promise<void> {
    const ownerOid = new Types.ObjectId(ownerId);

    const account = await this.accountModel.create({
      name: 'VIP Customer Inc.',
      industry: 'Healthcare',
      website: 'https://vip-customer.example.com',
      assignedTo: ownerOid,
      tenants: [tenantRef],
    });

    await this.contactModel.insertMany([
      {
        firstName: 'Anna',
        lastName: 'Smith',
        emails: [{ email: 'anna@vip-customer.example.com', isPrimary: true }],
        phones: [{ phone: '+1-555-300-0001', isPrimary: true }],
        title: 'IT Manager',
        accountId: account._id,
        assignedTo: ownerOid,
        lifecycleStage: 'customer',
        lifecycleStatus: 'active',
        source: 'Website',
        tenants: [tenantRef],
      },
      {
        firstName: 'James',
        lastName: 'Wilson',
        emails: [{ email: 'james@vip-customer.example.com', isPrimary: true }],
        title: 'Support Lead',
        accountId: account._id,
        assignedTo: ownerOid,
        lifecycleStage: 'customer',
        lifecycleStatus: 'active',
        source: 'Referral',
        tenants: [tenantRef],
      },
    ]);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Marketing focus
  // ─────────────────────────────────────────────────────────────────────────────

  private async seedMarketing(
    tenantRef: { tenantId: Types.ObjectId },
    ownerId: string,
  ): Promise<void> {
    const ownerOid = new Types.ObjectId(ownerId);

    await this.contactModel.insertMany([
      {
        firstName: 'Lisa',
        lastName: 'Wang',
        emails: [{ email: 'lisa@marketing-demo.example.com', isPrimary: true }],
        title: 'Marketing Director',
        assignedTo: ownerOid,
        lifecycleStage: 'subscriber',
        lifecycleStatus: 'engaged',
        source: 'Facebook',
        tenants: [tenantRef],
      },
      {
        firstName: 'David',
        lastName: 'Park',
        emails: [
          { email: 'david@marketing-demo.example.com', isPrimary: true },
        ],
        title: 'Growth Manager',
        assignedTo: ownerOid,
        lifecycleStage: 'mql',
        lifecycleStatus: 'qualified',
        source: 'Google Ads',
        tenants: [tenantRef],
      },
      {
        firstName: 'Maria',
        lastName: 'Garcia',
        emails: [
          { email: 'maria@marketing-demo.example.com', isPrimary: true },
        ],
        title: 'Content Strategist',
        assignedTo: ownerOid,
        lifecycleStage: 'lead',
        lifecycleStatus: 'nurturing',
        source: 'Website',
        tenants: [tenantRef],
      },
    ]);
  }
}
