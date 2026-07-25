import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

/**
 * ResourceLoaderRegistry — the Policy Information Point.
 *
 * Hydrates the record a record-level authorization decision is about, so ABAC
 * conditions on `resource.*` have attributes to evaluate against.
 *
 * Loading goes through the Mongoose model rather than a feature repository, for
 * three reasons:
 *   - the tenant plugin is installed on the schema, so the read is
 *     automatically tenant-scoped and fails closed without CLS context;
 *   - AuthorizationModule stays decoupled from every feature module (importing
 *     ~15 repositories here would create a dependency cycle with the modules
 *     that consume the PDP);
 *   - it is a projection-free `.lean()` read, which is what an attribute
 *     evaluator wants — a plain object, no getters, no domain mapping.
 *
 * A loader key is the `resource` name used in `@UseAcl` / the permission
 * registry; it maps to the Mongoose model that stores it.
 */
const RESOURCE_MODELS: Record<string, string> = {
  contacts: 'ContactSchemaClass',
  accounts: 'AccountSchemaClass',
  deals: 'DealSchemaClass',
  tickets: 'TicketSchemaClass',
  tasks: 'TaskSchemaClass',
  leads: 'ContactSchemaClass', // leads are contacts in a lead lifecycle stage
  notes: 'NoteSchemaClass',
  groups: 'GroupSchemaClass',
  users: 'UserSchemaClass',
  omni_channel: 'OmniConversationSchemaClass',
  files: 'FileSchemaClass',
  tags: 'TagSchemaClass',
};

@Injectable()
export class ResourceLoaderRegistry {
  private readonly logger = new Logger(ResourceLoaderRegistry.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Loader keys this registry can hydrate — used by the wiring test. */
  static get supportedKeys(): string[] {
    return Object.keys(RESOURCE_MODELS);
  }

  /**
   * Load a record as a plain object, or undefined when it does not exist / is
   * outside the caller's tenant.
   *
   * A miss returns undefined rather than throwing: the caller (AclGuard) still
   * evaluates ACL and ABAC, and `resource.*` conditions simply do not hold. The
   * handler then produces its own 404, which keeps the "missing" and "forbidden"
   * responses consistent with the non-ACL routes.
   */
  async load(
    loaderKey: string,
    tenantId: string,
    resourceId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const modelName = RESOURCE_MODELS[loaderKey];
    if (!modelName) {
      // A route declared @LoadResource with a key nobody registered. Failing
      // loudly is correct: silently returning undefined would downgrade every
      // resource-scoped policy on that route to a no-op, which is the exact
      // class of silent weakening this whole mechanism exists to prevent.
      throw new Error(
        `[PIP] No resource loader registered for "${loaderKey}". ` +
          `Add it to RESOURCE_MODELS in resource-loader.registry.ts. ` +
          `Known keys: ${Object.keys(RESOURCE_MODELS).join(', ')}`,
      );
    }

    try {
      const model = this.connection.model(modelName);
      // The tenant plugin adds the tenant predicate from CLS; passing tenantId
      // explicitly would be stripped and re-added, so we rely on the plugin and
      // keep tenantId in the signature for loaders that are not plugin-backed.
      const doc = await model.findById(resourceId).lean().exec();
      return (doc as Record<string, unknown>) ?? undefined;
    } catch (error) {
      // A load failure must NOT become an allow. Propagate so the guard fails
      // the request rather than deciding without attributes.
      this.logger.error(
        `[PIP] Failed to load ${loaderKey}/${resourceId} for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}
