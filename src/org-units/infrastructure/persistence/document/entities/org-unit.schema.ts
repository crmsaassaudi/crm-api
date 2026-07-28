import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OrgUnitSchemaDocument = HydratedDocument<OrgUnitSchemaClass>;

/**
 * OrgUnit — one node of a tenant's organisational chart.
 *
 * Exactly one concept covers what the spec called Department, Branch, Division
 * and Business Unit: those are *depths* in this tree, not separate fields. A
 * tenant that wants "Branch > Department > Team" creates three levels; a flat
 * tenant creates one. Nothing in the authorization path reads `depth` to decide
 * anything, so adding or removing a level is a data change, not a code change.
 *
 * Distinct from Group on two axes, and those two axes are the whole definition:
 *   - cardinality: a user belongs to exactly ONE org unit, to many groups;
 *   - ownership:   a record carries ONE `orgUnitId`, and never a group id.
 * If a candidate concept fails either test it is a group, not an org unit.
 *
 * `path` is a materialised path of ancestor ids, ROOT-first, each id delimited
 * on both sides: `/<rootId>/<childId>/<selfId>/`. Two reasons:
 *   - a subtree is one indexed prefix query (`path: /^\/a\/b\//`) instead of a
 *     recursive $graphLookup on every request that resolves data visibility;
 *   - the delimiters make the prefix unambiguous, so unit `/a/b/` cannot match
 *     a sibling whose id merely starts with the same characters.
 * The cost is that reparenting must rewrite the subtree's paths — done in one
 * bulkWrite in OrgUnitsService, which is the right trade when reads outnumber
 * reparents by orders of magnitude.
 */
@Schema({
  timestamps: true,
  collection: 'org_units',
  toJSON: { virtuals: true, getters: true },
})
export class OrgUnitSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, trim: true, maxlength: 120 })
  name: string;

  /**
   * Tenant-authored stable identifier (e.g. 'SALES-NORTH'). Optional, but when
   * present it is unique per tenant so imports and integrations have something
   * to key on that survives a rename.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 40 })
  code?: string | null;

  @Prop({ type: String, default: null })
  description?: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OrgUnitSchemaClass',
    default: null,
    index: true,
  })
  parentId: string | null;

  /** Materialised ancestor path, self included: `/rootId/.../selfId/`. */
  @Prop({ type: String, required: true, index: true })
  path: string;

  /** Number of ancestors. 0 for a root. Derived from `path`; never authoritative. */
  @Prop({ type: Number, required: true, default: 0 })
  depth: number;

  /**
   * Head of this unit. Unlike the group `managerId` this replaces, it carries
   * real authorization weight: a manager is what makes ORG_UNIT_SUBTREE scope
   * meaningful, and it is resolved in the visibility path rather than only
   * rendered in a settings page.
   */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  managerId?: string | null;

  /**
   * Co-managers of this unit, beyond the single head above.
   *
   * A real org chart has more than one person who must see a whole team: a
   * department head plus a deputy, two shift leads over one support desk, a
   * team lead plus the QA manager auditing them. `managerId` alone forced
   * tenants to model that by inventing extra units or by widening everyone's
   * role scope to the whole tenant, which is the failure this closes.
   *
   * `managerId` stays the *primary* head (shown as the unit's owner in the UI);
   * authorization treats it as one entry of the manager set — see
   * `OrgUnitsService.listManagerUnitIds`.
   *
   * Indexed because the visibility path queries by it on every request for a
   * principal who manages anything.
   */
  @Prop({
    type: [{ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' }],
    default: [],
    index: true,
  })
  managerIds: string[];

  @Prop({ default: true })
  isActive: boolean;
}

export const OrgUnitSchema = SchemaFactory.createForClass(OrgUnitSchemaClass);

OrgUnitSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

OrgUnitSchema.index({ tenantId: 1, name: 1 }, { unique: true });

// Unique per tenant only when a code is actually set. Partial rather than
// sparse because rows store `code: null` explicitly instead of omitting it,
// and a sparse unique index would then treat every null as a collision.
OrgUnitSchema.index(
  { tenantId: 1, code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } } },
);

// Serves the subtree prefix query. Compound with tenantId so a prefix scan can
// never walk into another tenant's rows even if a caller forges the regex.
OrgUnitSchema.index({ tenantId: 1, path: 1 }, { name: 'org_units_subtree' });
