import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { ContactSchemaClass } from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { CampaignDocument, CampaignSchemaClass } from './campaign.schema';
import {
  CampaignRecipientSchemaClass,
  SkipReason,
} from './campaign-recipient.schema';
import {
  AudienceContact,
  CampaignAudienceService,
} from './campaign-audience.service';
import {
  CAMPAIGN_MATERIALISE_BATCH_SIZE,
  CAMPAIGN_MAX_AUDIENCE,
  CAMPAIGN_SEND_BATCH_SIZE,
} from './campaigns.constants';
import {
  CampaignAbortError,
  CAMPAIGN_SENDERS,
  CampaignSenderRegistry,
  CampaignSendSession,
} from './senders/campaign-sender';
import { assertChannelConfig } from './domain/campaign-channel';
import { nextAllowedSendTime } from './domain/quiet-hours';
import { buildMergeValues } from './domain/personalise';
import { CampaignProducer } from './queue/campaign.producer';

/**
 * Stand-in values for a test send.
 *
 * Real-looking rather than `{{firstName}}` echoed back, because the point of a
 * test is to see the message a customer will see — including whether the
 * greeting reads correctly once a name is actually substituted.
 */
const TEST_MERGE_VALUES = {
  firstName: 'Sara',
  lastName: 'Ahmed',
  fullName: 'Sara Ahmed',
  companyName: 'Northwind Trading',
};

/** How often to re-read the campaign status inside a batch, in recipients. */
const PAUSE_CHECK_INTERVAL = 20;

/** A claim older than this belonged to a worker that died mid-batch. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

const MAX_ERROR_LENGTH = 500;

/**
 * The worker half of the campaign module: turn a launched campaign into messages.
 *
 * Split from `CampaignsService` because the two have different callers and
 * different failure rules — a request may throw a 409 at a user, a worker must
 * instead record the failure somewhere the user will see it later.
 */
@Injectable()
export class CampaignRunnerService {
  private readonly logger = new Logger(CampaignRunnerService.name);

  constructor(
    @InjectModel(CampaignSchemaClass.name)
    private readonly model: Model<CampaignDocument>,
    @InjectModel(CampaignRecipientSchemaClass.name)
    private readonly recipients: Model<CampaignRecipientSchemaClass>,
    @InjectModel(ContactSchemaClass.name)
    private readonly contacts: Model<ContactSchemaClass>,
    @Inject(CAMPAIGN_SENDERS)
    private readonly senders: CampaignSenderRegistry,
    private readonly audience: CampaignAudienceService,
    private readonly producer: CampaignProducer,
    private readonly cls: ClsService,
  ) {}

  /**
   * Send the campaign once, to an address the caller names.
   *
   * Writes no ledger row: a test is not part of the audience, and counting it
   * would put a recipient in the report who was never targeted. It does consume
   * real provider quota, which is why the endpoint is gated on `launch`.
   */
  async testSend(
    campaignId: string,
    destination: string,
  ): Promise<{ ok: true }> {
    const campaign = await this.load(campaignId);
    if (!campaign)
      throw new NotFoundException(`Campaign ${campaignId} not found`);

    assertChannelConfig(campaign.channelConfig);
    this.assertDestinationMatchesChannel(campaign, destination);

    const tenantId =
      this.cls.get<string>('activeTenantId') ??
      this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context is required.');

    const sender = this.senders.get(campaign.channelType);
    if (!sender) {
      throw new BadRequestException(
        `No sender is configured for ${campaign.channelType} on this deployment.`,
      );
    }

    const session = await sender.open(tenantId, campaign.channelConfig);
    try {
      await session.send(destination.trim(), TEST_MERGE_VALUES);
    } finally {
      await session.close?.();
    }

    return { ok: true };
  }

  private assertDestinationMatchesChannel(
    campaign: CampaignDocument,
    destination: string,
  ): void {
    const value = destination.trim();
    if (campaign.channelType === 'email') {
      if (!value.includes('@')) {
        throw new BadRequestException('Enter an email address to test with.');
      }
      return;
    }
    if (!value.startsWith('+')) {
      throw new BadRequestException(
        'Enter a phone number in international format, starting with +.',
      );
    }
  }

  /**
   * Prepare a run and queue its work.
   *
   * Idempotent by design, because it is the single entry point for launching,
   * resuming and retrying: materialisation is skipped once the ledger exists, and
   * queuing only ever picks up rows still `pending`.
   */
  async dispatch(
    campaignId: string,
    tenantId: string,
    scope?: object,
  ): Promise<void> {
    const campaign = await this.load(campaignId);
    if (!campaign) return;

    if (campaign.status !== 'sending') {
      this.logger.log(
        `Campaign ${campaign.code} is ${campaign.status}; dispatch skipped.`,
      );
      return;
    }

    if (!campaign.stats?.audienceSize) {
      try {
        const materialised = await this.materialise(campaign, tenantId);
        if (!materialised) return;
      } catch (error) {
        if (!(error instanceof CampaignAbortError)) throw error;
        // Wrong for the whole audience, not for one recipient: the campaign
        // pauses with the reason on it rather than failing a job nobody reads.
        await this.abort(campaignId, error.message);
        return;
      }
    }

    await this.recoverStaleClaims(campaignId);

    const queued = await this.queuePending(campaignId, tenantId, scope);
    if (queued === 0) await this.finaliseIfDone(campaignId);
  }

  /**
   * Send to one batch of recipients.
   *
   * Returns without sending when the campaign is no longer running, so a pause or
   * a cancel takes effect on batches that were already queued — there is no way
   * to un-queue thousands of jobs, and there does not need to be.
   */
  async sendBatch(
    campaignId: string,
    recipientIds: string[],
    tenantId: string,
    scope?: object,
  ): Promise<void> {
    const campaign = await this.load(campaignId);
    if (!campaign || campaign.status !== 'sending') return;

    const waitFor = this.quietHoursDelay(campaign);
    if (waitFor > 0) {
      // Re-queued rather than dropped: the batch is still owed, it just must not
      // arrive at 03:00. Long campaigns cross into quiet hours mid-run, which is
      // why this is checked per batch and not once at launch.
      await this.producer.enqueueSendBatch(
        { campaignId, recipientIds, tenantId, scope },
        waitFor,
      );
      return;
    }

    const session = await this.openSession(campaign, tenantId);
    if (!session) return;

    const outcome = { sent: 0, failed: 0 };
    try {
      await this.deliverAll(campaign, recipientIds, session, outcome);
    } catch (error) {
      if (error instanceof CampaignAbortError) {
        await this.abort(campaignId, error.message);
      } else {
        throw error;
      }
    } finally {
      await this.commitOutcome(campaignId, outcome);
      await session.close?.();
    }

    await this.finaliseIfDone(campaignId);
  }

  private async deliverAll(
    campaign: CampaignDocument,
    recipientIds: string[],
    session: CampaignSendSession,
    outcome: { sent: number; failed: number },
  ): Promise<void> {
    const campaignId = String(campaign._id);
    const contactNames = await this.loadContactNames(campaignId, recipientIds);

    for (const [index, recipientId] of recipientIds.entries()) {
      // A batch of 100 sends can take minutes, so a pause issued halfway through
      // must be noticed rather than waited out.
      if (index > 0 && index % PAUSE_CHECK_INTERVAL === 0) {
        const stillSending = await this.model
          .countDocuments({ _id: campaign._id, status: 'sending' })
          .exec();
        if (!stillSending) return;
      }

      const claimed = await this.claim(recipientId);
      // Already sent, already skipped, or claimed by another worker — either way
      // this job has nothing to do for it. This compare-and-set is what makes a
      // replayed job safe.
      if (!claimed?.destination) continue;

      try {
        const result = await session.send(
          claimed.destination,
          buildMergeValues(contactNames.get(String(claimed.contactId)) ?? {}),
        );
        await this.recipients
          .updateOne(
            { _id: claimed._id },
            {
              $set: {
                status: 'sent',
                sentAt: new Date(),
                providerMessageId: result.providerMessageId ?? null,
                error: null,
              },
            },
          )
          .exec();
        outcome.sent += 1;
      } catch (error) {
        if (error instanceof CampaignAbortError) {
          // Put the recipient back: the failure is the campaign's, not theirs, so
          // they must still be sent to once the cause is fixed.
          await this.recipients
            .updateOne({ _id: claimed._id }, { $set: { status: 'pending' } })
            .exec();
          throw error;
        }
        await this.recipients
          .updateOne(
            { _id: claimed._id },
            {
              $set: {
                status: 'failed',
                error: String((error as Error).message ?? error).slice(
                  0,
                  MAX_ERROR_LENGTH,
                ),
              },
            },
          )
          .exec();
        outcome.failed += 1;
      }
    }
  }

  /**
   * Write the audience into the ledger.
   *
   * Returns false when the run cannot continue. Counters are read back from the
   * ledger afterwards rather than accumulated in memory, so a dispatch that
   * crashed halfway and retried reports the truth instead of double-counting the
   * batches it had already written.
   */
  private async materialise(
    campaign: CampaignDocument,
    tenantId: string,
  ): Promise<boolean> {
    const campaignId = String(campaign._id);
    const seenDestinations = new Set<string>();
    let batch: AudienceContact[] = [];
    let scanned = 0;

    const cursor = this.audience.cursor(await this.frozenPredicate(campaignId));
    try {
      for await (const contact of cursor) {
        batch.push(contact as AudienceContact);
        scanned += 1;

        if (scanned > CAMPAIGN_MAX_AUDIENCE) {
          // Everything written so far goes with it. Leaving a partial ledger
          // behind would make the next dispatch believe the audience was already
          // materialised and send to an arbitrary prefix of it.
          await this.recipients
            .deleteMany({ campaignId: new Types.ObjectId(campaignId) })
            .exec();
          await this.abort(
            campaignId,
            `The audience grew past ${CAMPAIGN_MAX_AUDIENCE.toLocaleString()} contacts since launch. Narrow it and launch again.`,
          );
          return false;
        }

        if (batch.length >= CAMPAIGN_MATERIALISE_BATCH_SIZE) {
          await this.writeRecipients(
            campaign,
            batch,
            tenantId,
            seenDestinations,
          );
          batch = [];
        }
      }
      if (batch.length) {
        await this.writeRecipients(campaign, batch, tenantId, seenDestinations);
      }
    } finally {
      await cursor.close();
    }

    const [audienceSize, sendable] = await Promise.all([
      this.recipients.countDocuments({ campaignId: campaign._id }).exec(),
      this.recipients
        .countDocuments({ campaignId: campaign._id, status: 'pending' })
        .exec(),
    ]);

    await this.model
      .updateOne(
        { _id: campaign._id },
        {
          $set: {
            'stats.audienceSize': audienceSize,
            'stats.queued': sendable,
            'stats.skipped': audienceSize - sendable,
          },
        },
      )
      .exec();

    this.logger.log(
      `Campaign ${campaign.code} materialised: ${audienceSize} matched, ${sendable} sendable.`,
    );
    return true;
  }

  private async writeRecipients(
    campaign: CampaignDocument,
    batch: AudienceContact[],
    tenantId: string,
    seenDestinations: Set<string>,
  ): Promise<void> {
    const decisions = await this.audience.decide(
      batch,
      campaign.channelType,
      seenDestinations,
    );

    // `as any` on the ops, not on the values: the schema types these references
    // as `string` (which is what a caller reads back), while the driver needs
    // real ObjectIds to match the unique index. Writing strings here would
    // create a second, non-matching row for every contact.
    const operations = decisions.map((decision) => ({
      updateOne: {
        filter: {
          campaignId: new Types.ObjectId(String(campaign._id)),
          contactId: new Types.ObjectId(decision.contactId),
        },
        // `$setOnInsert` only. A retried dispatch must never reset a row that
        // has already been sent — that is precisely how someone gets the same
        // promotion twice.
        update: {
          $setOnInsert: {
            tenantId: new Types.ObjectId(tenantId),
            campaignId: new Types.ObjectId(String(campaign._id)),
            contactId: new Types.ObjectId(decision.contactId),
            channel: campaign.channelType,
            destination: decision.destination,
            status: decision.skipReason ? 'skipped' : 'pending',
            skipReason: (decision.skipReason ?? null) as SkipReason | null,
            attempts: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
        upsert: true,
      },
    }));

    // Unordered so one duplicate-key collision does not abandon the rest of the
    // batch. `bulkWrite` bypasses Mongoose middleware, which is why `tenantId`
    // is written explicitly above rather than left to the tenant plugin.
    await this.recipients.bulkWrite(operations as any, { ordered: false });
  }

  /** Queue every recipient still waiting, in batches. Returns how many. */
  private async queuePending(
    campaignId: string,
    tenantId: string,
    scope?: object,
  ): Promise<number> {
    const cursor = this.recipients
      .find({ campaignId: new Types.ObjectId(campaignId), status: 'pending' })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .lean()
      .batchSize(CAMPAIGN_SEND_BATCH_SIZE)
      .cursor();

    let queued = 0;
    let batch: string[] = [];
    try {
      for await (const row of cursor) {
        batch.push(String(row._id));
        if (batch.length >= CAMPAIGN_SEND_BATCH_SIZE) {
          await this.producer.enqueueSendBatch({
            campaignId,
            recipientIds: batch,
            tenantId,
          });
          queued += batch.length;
          batch = [];
        }
      }
      if (batch.length) {
        await this.producer.enqueueSendBatch({
          campaignId,
          recipientIds: batch,
          tenantId,
          scope,
        });
        queued += batch.length;
      }
    } finally {
      await cursor.close();
    }

    return queued;
  }

  /**
   * Free rows a dead worker left claimed.
   *
   * Without this a crash mid-batch strands its recipients in `sending` forever:
   * the claim CAS skips them, so they are never sent and the campaign never
   * completes.
   */
  private async recoverStaleClaims(campaignId: string): Promise<void> {
    const { modifiedCount } = await this.recipients
      .updateMany(
        {
          campaignId: new Types.ObjectId(campaignId),
          status: 'sending',
          updatedAt: { $lt: new Date(Date.now() - STALE_CLAIM_MS) },
        },
        { $set: { status: 'pending' } },
      )
      .exec();

    if (modifiedCount) {
      this.logger.warn(
        `Campaign ${campaignId}: released ${modifiedCount} stale claim(s).`,
      );
    }
  }

  private async claim(recipientId: string) {
    return this.recipients
      .findOneAndUpdate(
        { _id: recipientId, status: 'pending' },
        { $set: { status: 'sending' }, $inc: { attempts: 1 } },
        { new: true },
      )
      .lean()
      .exec();
  }

  private async openSession(
    campaign: CampaignDocument,
    tenantId: string,
  ): Promise<CampaignSendSession | null> {
    try {
      assertChannelConfig(campaign.channelConfig);
      const sender = this.senders.get(campaign.channelType);
      if (!sender) {
        throw new CampaignAbortError(
          `No sender is configured for ${campaign.channelType} on this deployment.`,
        );
      }
      return await sender.open(tenantId, campaign.channelConfig);
    } catch (error) {
      // Anything wrong with the configuration is wrong for the whole audience, so
      // the campaign pauses with the reason instead of recording it a hundred
      // thousand times.
      await this.abort(
        String(campaign._id),
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  private quietHoursDelay(campaign: CampaignDocument): number {
    const resumeAt = nextAllowedSendTime(
      new Date(),
      campaign.schedule?.timezone ?? 'UTC',
      campaign.schedule?.quietHours ?? null,
    );
    return Math.max(0, resumeAt.getTime() - Date.now());
  }

  private async commitOutcome(
    campaignId: string,
    outcome: { sent: number; failed: number },
  ): Promise<void> {
    if (!outcome.sent && !outcome.failed) return;
    // One increment per batch, not per recipient: a 500k campaign would otherwise
    // perform 500k writes against a single hot document.
    await this.model
      .updateOne(
        { _id: campaignId },
        {
          $inc: {
            'stats.sent': outcome.sent,
            'stats.failed': outcome.failed,
          },
        },
      )
      .exec();
  }

  private async abort(campaignId: string, reason: string): Promise<void> {
    await this.model
      .updateOne(
        { _id: campaignId, status: 'sending' },
        {
          $set: {
            status: 'paused',
            lastError: reason.slice(0, MAX_ERROR_LENGTH),
          },
        },
      )
      .exec();
    this.logger.error(`Campaign ${campaignId} paused: ${reason}`);
  }

  /** Complete the campaign once nothing is left to do. */
  private async finaliseIfDone(campaignId: string): Promise<void> {
    const remaining = await this.recipients
      .countDocuments({
        campaignId: new Types.ObjectId(campaignId),
        status: { $in: ['pending', 'sending'] },
      })
      .exec();
    if (remaining > 0) return;

    // Guarded on `sending`, so a campaign someone paused or cancelled while the
    // last batch was in flight is not quietly marked complete.
    await this.model
      .updateOne(
        { _id: campaignId, status: 'sending' },
        { $set: { status: 'completed', completedAt: new Date() } },
      )
      .exec();
  }

  /** Names for merge tags, one query per batch rather than one per recipient. */
  private async loadContactNames(
    campaignId: string,
    recipientIds: string[],
  ): Promise<Map<string, AudienceContact>> {
    const rows = await this.recipients
      .find({
        _id: { $in: recipientIds.map((id) => new Types.ObjectId(id)) },
        campaignId: new Types.ObjectId(campaignId),
      })
      .select({ contactId: 1 })
      .lean()
      .exec();

    const contactIds = rows.map((row) => row.contactId);
    if (!contactIds.length) return new Map();

    const contacts = await this.contacts
      .find({ _id: { $in: contactIds } })
      .select({ firstName: 1, lastName: 1, companyName: 1 })
      .lean()
      .exec();

    return new Map(
      contacts.map((contact: any) => [
        String(contact._id),
        contact as AudienceContact,
      ]),
    );
  }

  private async load(campaignId: string): Promise<CampaignDocument | null> {
    if (!Types.ObjectId.isValid(campaignId)) return null;
    return this.model.findOne({ _id: campaignId, deletedAt: null }).exec();
  }

  /**
   * The predicate this run is bound to, as frozen at launch.
   *
   * Read separately from `load()` because `audienceSnapshot` is `select: false`
   * and only materialisation needs it — pulling a compiled query tree into every
   * pause check would be a cost paid on every batch for nothing.
   *
   * Resolving it here rather than re-compiling the definition is what makes a run
   * self-contained: a segment edited after launch cannot change who is mid-send,
   * and a segment deleted after launch cannot fail the job.
   */
  private async frozenPredicate(campaignId: string): Promise<FilterQuery<any>> {
    const frozen = await this.model
      .findOne({ _id: campaignId })
      .select('+audienceSnapshot')
      .lean()
      .exec();

    const predicate = frozen?.audienceSnapshot?.predicate;
    if (!predicate) {
      throw new CampaignAbortError(
        'This campaign has no frozen audience. Launch it again.',
      );
    }
    return predicate;
  }
}
