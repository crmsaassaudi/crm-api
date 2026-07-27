import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AssignmentSettingDocument,
  AssignmentSettingSchemaClass,
} from './infrastructure/persistence/assignment-setting.schema';
import {
  ASSIGNMENT_OBJECT_TYPES,
  AssignmentObjectType,
} from './domain/assignment.types';
import { AssignmentConfigService } from './core/assignment-config.service';

/**
 * Per-objectType seed defaults.
 *
 * Conversations arrive from customers and must be picked up by someone, so
 * auto-assignment is on. CRM records are created by staff who usually intend to
 * own what they create, so it is off until an admin turns it on — which matches
 * the behaviour before consolidation (`omni_routing.autoAssignmentEnabled: true`
 * vs `assignment_settings.autoAssignEnabled: false`) rather than quietly
 * changing it for existing workspaces.
 */
const SEED_DEFAULTS: Record<
  AssignmentObjectType,
  Partial<AssignmentSettingSchemaClass>
> = {
  Conversation: {
    autoAssignEnabled: true,
    defaultStrategy: 'round-robin',
    defaultMaxCapacity: 10,
    stickyFallbackStrategy: 'least-busy',
    skillBasedRoutingEnabled: false,
    // Conversations are only useful with someone present to answer them.
    requireOnline: true,
    preferPreviousAssignee: false,
    previousAssigneeTimeoutHours: 72,
    previousAssigneeWaitMinutes: 3,
  },
  Lead: recordDefaults(50),
  Contact: recordDefaults(50),
  Account: recordDefaults(50),
  Ticket: recordDefaults(25),
  Task: recordDefaults(25),
  Deal: recordDefaults(25),
};

function recordDefaults(
  capacity: number,
): Partial<AssignmentSettingSchemaClass> {
  return {
    autoAssignEnabled: false,
    defaultStrategy: 'round-robin',
    defaultMaxCapacity: capacity,
    stickyFallbackStrategy: 'round-robin',
    skillBasedRoutingEnabled: false,
    // Records can sit in a queue overnight; requiring an online owner would
    // leave them unassigned outside working hours for no benefit.
    requireOnline: false,
    preferPreviousAssignee: false,
  };
}

/**
 * Creates the assignment settings row for each objectType when a tenant is
 * provisioned.
 *
 * Idempotent: `$setOnInsert` only, so re-running never overwrites an admin's
 * choices. Called on `tenant.created` and by the consolidation migration for
 * existing tenants.
 */
@Injectable()
export class AssignmentSeederService {
  private readonly logger = new Logger(AssignmentSeederService.name);

  constructor(
    @InjectModel(AssignmentSettingSchemaClass.name)
    private readonly model: Model<AssignmentSettingDocument>,
    private readonly config: AssignmentConfigService,
  ) {}

  async seedForTenant(tenantId: string): Promise<void> {
    await Promise.all(
      ASSIGNMENT_OBJECT_TYPES.map((objectType) =>
        this.model
          .updateOne(
            { tenantId, objectType },
            {
              $setOnInsert: {
                tenantId,
                objectType,
                ...SEED_DEFAULTS[objectType],
              },
            },
            { upsert: true },
          )
          .exec(),
      ),
    );
    await this.config.invalidate(tenantId);
    this.logger.log(`Seeded assignment settings for tenant ${tenantId}`);
  }
}
