import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { AssignmentScope, CandidateSourcePort } from '../../core/ports';

/**
 * The slice of the presence layer the record adapter needs.
 *
 * Declared here rather than importing AgentPresenceService so this module does
 * not depend on omni-inbound. The dependency is injected at runtime by
 * OmniInboundModule (see `setPresenceProvider`), which also means there is
 * exactly ONE AgentPresenceService instance in the process — providing a second
 * copy in this module, as the old engine did, made its
 * `@OnEvent('user.profile.updated')` handler run twice per event.
 */
export interface PresenceSnapshotProvider {
  getAllAgents(tenantId: string): Promise<
    Array<{
      userId: string;
      presenceStatus: string;
      connectionStatus: string;
    }>
  >;
}

/**
 * Candidate resolution for CRM records.
 *
 * There is no channel-style access list for records, so the base pool is
 * unrestricted (`undefined`) and the rule's team — or the default team — decides
 * who is in scope. Returning `[]` here instead would mean "nobody qualifies",
 * which is a different and much worse answer.
 */
@Injectable()
export class RecordCandidatePort implements CandidateSourcePort {
  private readonly logger = new Logger(RecordCandidatePort.name);

  private presence: PresenceSnapshotProvider | null = null;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('GroupSchemaClass') private readonly groupModel: Model<any>,
  ) {}

  /**
   * Supplied by OmniInboundModule at init.
   *
   * Optional by design: records can be assigned on a deployment where the omni
   * presence layer is not running, and `requireOnline` then degrades to "no
   * availability filter" rather than "nobody is assignable".
   */
  setPresenceProvider(provider: PresenceSnapshotProvider): void {
    this.presence = provider;
    this.logger.log('Presence provider wired for record assignment');
  }

  isPresenceProviderConfigured(): boolean {
    return this.presence !== null;
  }

  basePool(_scope: AssignmentScope): Promise<string[] | undefined> {
    return Promise.resolve(undefined);
  }

  async groupMembers(
    _scope: AssignmentScope,
    groupIds: string[],
  ): Promise<string[]> {
    const ids = groupIds.filter((id) => Types.ObjectId.isValid(id));
    if (ids.length === 0) return [];
    try {
      const groups = await this.groupModel
        .find({ _id: { $in: ids } })
        .select({ memberIds: 1 })
        .lean()
        .exec();
      const members = groups.flatMap((g: any) =>
        (g.memberIds ?? g.members ?? []).map(String),
      );
      return [...new Set(members)];
    } catch (err: any) {
      this.logger.warn(
        `Failed to resolve members of group(s) ${ids.join(', ')}: ${err.message}`,
      );
      return [];
    }
  }

  /**
   * Skills come from `user.skills`, which stores skill apiNames.
   *
   * Read straight from the users collection rather than through UsersService to
   * avoid a module cycle (users → roles → permissions → … → assignment) for what
   * is a single projected read.
   */
  async skills(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    const ids = candidateIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return result;

    try {
      // Defense-in-depth: `ids` are expected to already be tenant-scoped
      // (they come from `groupMembers()`, which queries the tenant-filtered
      // Group model), but this is a raw driver call bypassing that plugin —
      // without its own filter, a future caller passing an externally-merged
      // candidate list could leak skill data across tenants.
      const users = await this.connection
        .collection('users')
        .find({
          _id: { $in: ids },
          'tenants.tenantId': Types.ObjectId.isValid(scope.tenantId)
            ? new Types.ObjectId(scope.tenantId)
            : scope.tenantId,
        })
        .project({ _id: 1, skills: 1 })
        .toArray();
      for (const user of users) {
        result.set(
          String(user._id),
          Array.isArray(user.skills) ? user.skills.map(String) : [],
        );
      }
    } catch (err: any) {
      this.logger.error(`Failed to read candidate skills: ${err.message}`);
    }
    return result;
  }

  /**
   * `requireOnline: true` drops offline candidates; false sorts online first so
   * a present colleague gets the work when everything else is equal.
   */
  async filterAvailable(
    scope: AssignmentScope,
    candidateIds: string[],
    requireOnline: boolean,
  ): Promise<string[]> {
    if (candidateIds.length === 0) return candidateIds;
    if (!this.presence) {
      if (requireOnline) {
        this.logger.warn(
          'Online assignment is required but no presence provider is available',
        );
        return [];
      }
      return candidateIds;
    }

    let onlineSet: Set<string>;
    try {
      const presences = await this.presence.getAllAgents(scope.tenantId);
      onlineSet = new Set(
        presences
          .filter(
            (p) =>
              p.presenceStatus === 'AVAILABLE' &&
              p.connectionStatus === 'CONNECTED',
          )
          .map((p) => p.userId),
      );
    } catch (err: any) {
      // A hard online requirement fails closed. Soft preference mode keeps the
      // original candidates when presence is temporarily unavailable.
      this.logger.warn(
        `Presence unavailable while filtering candidates: ${err.message} — skipping the availability filter`,
      );
      return requireOnline ? [] : candidateIds;
    }

    if (requireOnline) {
      return candidateIds.filter((id) => onlineSet.has(id));
    }
    const online = candidateIds.filter((id) => onlineSet.has(id));
    const offline = candidateIds.filter((id) => !onlineSet.has(id));
    return [...online, ...offline];
  }
}
