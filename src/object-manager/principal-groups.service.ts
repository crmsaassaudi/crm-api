import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  GroupSchemaClass,
  GroupSchemaDocument,
} from '../groups/infrastructure/persistence/document/entities/group.schema';

/**
 * The group ids of the caller, resolved once per request.
 *
 * Why this is not just `cls.get('userGroupId')`
 *
 * It was, and that was the bug. `DataMaskingInterceptor` read
 * `cls.get('userGroupId') || 'default'`, and nothing in the codebase ever wrote
 * `userGroupId`. Every masking decision therefore fell back to the `default`
 * layout, so per-group masking configured in Object Manager did nothing at all —
 * while a docblock in `export-context.ts` asserted the opposite ("`userGroupId`
 * above is snapshotted for exactly this reason"), which is how it stayed
 * unnoticed. The key was also singular, and a user belongs to many groups.
 *
 * Why not read `visibleGroupIds` directly
 *
 * `DataVisibilityInterceptor` does write `visibleGroupIds`, but depending on that
 * alone would repeat an earlier incident where a guard read group ids from CLS
 * that a *later* interceptor wrote, and silently saw none. Two concrete gaps:
 * the interceptor returns early for admins and owners before setting the key, and
 * worker/queue contexts have no interceptor at all.
 *
 * So: use the value if it is already there, otherwise resolve it and memoise for
 * the remainder of the request. Correct regardless of interceptor order, and at
 * most one indexed query (`{tenantId, memberIds}`) per request either way.
 *
 * Why the model and not GroupsModule
 *
 * Importing `GroupsModule` would add an edge from every record module to
 * `GroupsModule → UsersModule`, and a stray cycle in that graph has already cost
 * this codebase a two-hour outage where the API hung during bootstrap. One
 * projected query against the model needs no such edge.
 */
@Injectable()
export class PrincipalGroupsService {
  private readonly logger = new Logger(PrincipalGroupsService.name);

  /** Where this service parks its own resolution, distinct from the interceptor's key. */
  private static readonly CLS_KEY = 'principalGroupIds';

  constructor(
    private readonly cls: ClsService,
    @InjectModel(GroupSchemaClass.name)
    private readonly groupModel: Model<GroupSchemaDocument>,
  ) {}

  async groupIds(): Promise<string[]> {
    const memoised = this.cls.get<string[]>(PrincipalGroupsService.CLS_KEY);
    if (memoised) return memoised;

    const fromInterceptor = this.cls.get<string[]>('visibleGroupIds');
    if (Array.isArray(fromInterceptor)) {
      this.cls.set(PrincipalGroupsService.CLS_KEY, fromInterceptor);
      return fromInterceptor;
    }

    const resolved = await this.resolve();
    this.cls.set(PrincipalGroupsService.CLS_KEY, resolved);
    return resolved;
  }

  private async resolve(): Promise<string[]> {
    const userId = this.cls.get<string>('userId');
    if (!userId) return [];

    try {
      // `_id` only, and the tenant predicate comes from `tenantFilterPlugin`
      // rather than being spelled here — the plugin is the authority on tenant
      // scoping and a hand-written duplicate is one more place to get it wrong.
      // Served entirely by the `groups_member_lookup` index.
      const groups = await this.groupModel
        .find({ memberIds: userId })
        .select({ _id: 1 })
        .lean()
        .exec();
      return groups.map((group) => String(group._id)).filter(Boolean);
    } catch (error) {
      // An unresolvable membership must not widen access. Returning `[]` selects
      // the `default` layout, which is the tenant's baseline rather than a
      // per-group grant — the conservative direction. It is also logged, because
      // "nobody is in any group" and "the group query failed" produce identical
      // behaviour and only one of them is normal.
      this.logger.error(
        `Could not resolve group membership for user ${userId}; falling back to the default layout: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
