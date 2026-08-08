import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { ContactSchemaClass } from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { ContactIdentitySchemaClass } from '../contacts/identities/contact-identity.schema';
import { ContactAudienceService } from '../contacts/audience/contact-audience.service';
import { AudienceDefinition } from '../contacts/audience/audience-definition';
import {
  normalizeEmail,
  normalizePhone,
} from '../common/identity/identity-normalizer';
import { CampaignChannel, CHANNEL_DELIVERY } from './domain/campaign-channel';
import { SkipReason } from './campaign-recipient.schema';
import {
  CAMPAIGN_MATERIALISE_BATCH_SIZE,
  CAMPAIGN_PREVIEW_TIMEOUT_MS,
} from './campaigns.constants';

/** The only contact fields a send needs. Nothing else is read off the wire. */
export interface AudienceContact {
  _id: any;
  firstName?: string;
  lastName?: string;
  companyName?: string;
  emails?: string[];
  phones?: string[];
  omniIdentities?: Array<{ channelType: string; senderId: string }>;
  doNotCall?: boolean;
  emailOptIn?: boolean | null;
  smsOptIn?: boolean | null;
  whatsappOptIn?: boolean | null;
}

export const AUDIENCE_PROJECTION = {
  firstName: 1,
  lastName: 1,
  companyName: 1,
  emails: 1,
  phones: 1,
  omniIdentities: 1,
  doNotCall: 1,
  emailOptIn: 1,
  smsOptIn: 1,
  whatsappOptIn: 1,
} as const;

/** What materialisation decided about one contact. */
export interface RecipientDecision {
  contactId: string;
  destination: string | null;
  skipReason: SkipReason | null;
}

/**
 * What a marketer sees before launching: how many, and who falls out of the gaps.
 *
 * Every subtraction is reported on its own, because the three have three
 * different answers — a missing address needs enriching, a malformed one needs
 * correcting, and a refusal must be left alone. Rolled into one "unreachable"
 * figure they are indistinguishable and therefore un-actionable.
 */
export interface AudiencePreview {
  total: number;
  reachable: number;
  noDestination: number;
  refused: number;
  /** Reachable, but nobody ever asked them. A decision, not an error. */
  consentUnknown: number;
  /** False when the count timed out; every figure is then a stale best effort. */
  exact: boolean;
}

/**
 * Turns a campaign's audience into the people it will actually reach.
 *
 * Two responsibilities, deliberately separated: `ContactAudienceService` decides
 * WHICH contacts (and folds in the caller's row-level visibility, so a campaign
 * can never message someone its author is not allowed to open), and this decides
 * which of them this CHANNEL can be delivered to.
 */
@Injectable()
export class CampaignAudienceService {
  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contacts: Model<ContactSchemaClass>,
    @InjectModel(ContactIdentitySchemaClass.name)
    private readonly identities: Model<ContactIdentitySchemaClass>,
    private readonly audience: ContactAudienceService,
  ) {}

  buildFilter(
    definition: AudienceDefinition,
  ): Promise<FilterQuery<ContactSchemaClass>> {
    return this.audience.buildFilter(definition) as Promise<
      FilterQuery<ContactSchemaClass>
    >;
  }

  count(filter: FilterQuery<ContactSchemaClass>): Promise<number> {
    return this.contacts.countDocuments(filter).exec();
  }

  /**
   * Size an audience, broken down by why people fall out of it.
   *
   * One aggregation rather than five counts: the predicate behind an audience is
   * rarely index-covered — a `contains` condition is an unanchored regex — so
   * every separate count is another pass over the same rows. Bucketing in a
   * single `$group` walks them once, and the figures are guaranteed to add up
   * because they came from one snapshot.
   *
   * Bounded by `maxTimeMS`. A preview that hangs the wizard is worse than a
   * preview that admits it could not finish, so a timeout returns zeroes marked
   * `exact: false` instead of throwing.
   */
  async preview(
    filter: FilterQuery<ContactSchemaClass>,
    channel: CampaignChannel,
  ): Promise<AudiencePreview> {
    const { consentField, restrictionField } = CHANNEL_DELIVERY[channel];

    const refused: Record<string, unknown> = {
      $or: [
        { $eq: [`$${consentField}`, false] },
        ...(restrictionField
          ? [{ $eq: [`$${restrictionField}`, true] }]
          : []),
      ],
    };

    try {
      const [row] = await this.contacts
        .aggregate<Omit<AudiencePreview, 'exact'>>([
          { $match: filter },
          {
            $project: {
              // Order matters and is the same order `decide()` applies: a refusal
              // outranks a data problem, because "they asked us not to" and "we
              // have no number" call for opposite responses.
              bucket: {
                $switch: {
                  branches: [
                    { case: refused, then: 'refused' },
                    {
                      case: { $not: [this.hasDestinationExpression(channel)] },
                      then: 'no_destination',
                    },
                  ],
                  default: 'reachable',
                },
              },
              consentUnknown: {
                $eq: [{ $ifNull: [`$${consentField}`, null] }, null],
              },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              refused: { $sum: { $cond: [eq('$bucket', 'refused'), 1, 0] } },
              noDestination: {
                $sum: { $cond: [eq('$bucket', 'no_destination'), 1, 0] },
              },
              reachable: { $sum: { $cond: [eq('$bucket', 'reachable'), 1, 0] } },
              consentUnknown: {
                $sum: {
                  $cond: [
                    {
                      $and: [eq('$bucket', 'reachable'), '$consentUnknown'],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .option({ maxTimeMS: CAMPAIGN_PREVIEW_TIMEOUT_MS })
        .exec();

      return {
        total: row?.total ?? 0,
        reachable: row?.reachable ?? 0,
        noDestination: row?.noDestination ?? 0,
        refused: row?.refused ?? 0,
        consentUnknown: row?.consentUnknown ?? 0,
        exact: true,
      };
    } catch {
      return {
        total: 0,
        reachable: 0,
        noDestination: 0,
        refused: 0,
        consentUnknown: 0,
        exact: false,
      };
    }
  }

  /** A batching cursor over the audience, ordered by id for a stable walk. */
  cursor(filter: FilterQuery<ContactSchemaClass>) {
    return this.contacts
      .find(filter)
      .select(AUDIENCE_PROJECTION)
      .sort({ _id: 1 })
      .lean()
      .batchSize(CAMPAIGN_MATERIALISE_BATCH_SIZE)
      .cursor();
  }

  /**
   * Decide, for one batch of contacts, who gets the message and who is skipped.
   *
   * `seenDestinations` is threaded through the whole materialisation so two
   * contacts sharing an address receive one message, not two. An in-memory set
   * rather than a unique index: the index cannot tell "duplicate" from
   * "genuinely absent", so every skipped row would collide on `null`.
   *
   * Check order follows what is most useful to the operator — an explicit
   * refusal outranks a data problem, because "they asked us not to" and "we have
   * no number" call for opposite responses.
   */
  async decide(
    batch: AudienceContact[],
    channel: CampaignChannel,
    seenDestinations: Set<string>,
  ): Promise<RecipientDecision[]> {
    const resolved = batch.map((contact) => ({
      contactId: String(contact._id),
      ...(this.refusalOf(contact, channel) ??
        this.resolveDestination(contact, channel)),
    }));

    const blocked = await this.findBlockedDestinations(
      resolved
        .filter((entry) => entry.destination)
        .map((entry) => entry.destination as string),
      channel,
    );

    return resolved.map((entry) => {
      if (entry.skipReason || !entry.destination) return entry;

      const block = blocked.get(entry.destination);
      if (block) return { ...entry, skipReason: block };

      if (seenDestinations.has(entry.destination)) {
        return { ...entry, skipReason: 'duplicate' as SkipReason };
      }
      seenDestinations.add(entry.destination);
      return entry;
    });
  }

  /**
   * The contact's own refusal of this channel, if there is one.
   *
   * Enforced here and nowhere else, so there is no path to a send that skips it
   * — a campaign cannot opt out of it and neither can an audience definition.
   * `null` consent (never asked) is deliberately NOT a refusal; see
   * `CHANNEL_DELIVERY`.
   */
  private refusalOf(
    contact: AudienceContact,
    channel: CampaignChannel,
  ): { destination: string | null; skipReason: SkipReason | null } | null {
    const { consentField, restrictionField } = CHANNEL_DELIVERY[channel];

    if (restrictionField && contact[restrictionField] === true) {
      return { destination: null, skipReason: 'opted_out' };
    }
    if (contact[consentField] === false) {
      return { destination: null, skipReason: 'consent_withdrawn' };
    }
    return null;
  }

  /**
   * Where a message to this contact would go on this channel.
   *
   * WhatsApp reads the omni identity first, and trusts it differently from a
   * typed number. `senderId` is the MSISDN the PROVIDER gave us on a real
   * inbound message, so it is already international — it just arrives as bare
   * digits, because that is the form the Cloud API uses. A `phones[]` entry is
   * whatever a human typed, and may be a national number the gateway would
   * reject on every single send.
   */
  private resolveDestination(
    contact: AudienceContact,
    channel: CampaignChannel,
  ): { destination: string | null; skipReason: SkipReason | null } {
    if (channel === 'email') {
      const raw = contact.emails?.find((email) => email?.trim());
      if (!raw) return { destination: null, skipReason: 'no_destination' };
      const normalised = normalizeEmail(raw);
      return normalised.includes('@')
        ? { destination: normalised, skipReason: null }
        : { destination: null, skipReason: 'invalid_destination' };
    }

    const providerNumber =
      channel === 'whatsapp'
        ? contact.omniIdentities?.find(
            (identity) => identity.channelType === 'whatsapp',
          )?.senderId
        : undefined;

    if (providerNumber?.trim()) {
      // Stored with the '+' so it matches `contact_identities.normalisedValue`,
      // which is what the bounce and opt-out lookup compares against.
      const digits = normalizePhone(providerNumber).replace(/^\+/, '');
      return digits
        ? { destination: `+${digits}`, skipReason: null }
        : { destination: null, skipReason: 'invalid_destination' };
    }

    const typed = contact.phones?.find((phone) => phone?.trim());
    if (!typed) return { destination: null, skipReason: 'no_destination' };

    const normalised = normalizePhone(typed);
    // Both gateways require E.164. A national number would be rejected on every
    // send, so it is refused here — the operator sees "these numbers need a
    // country code" instead of a wall of identical provider errors.
    return normalised.startsWith('+')
      ? { destination: normalised, skipReason: null }
      : { destination: null, skipReason: 'invalid_destination' };
  }

  /**
   * Destinations that must not be sent to, and why.
   *
   * `optIn: false` is an explicit refusal recorded against the identity — the
   * address said no, which is narrower than the contact saying no and is
   * enforced independently of it.
   */
  private async findBlockedDestinations(
    destinations: string[],
    channel: CampaignChannel,
  ): Promise<Map<string, SkipReason>> {
    if (!destinations.length) return new Map();

    const rows = await this.identities
      .find({
        type: channel === 'email' ? 'email' : 'phone',
        normalisedValue: { $in: destinations },
        deletedAt: null,
        $or: [{ bouncedAt: { $ne: null } }, { optIn: false }],
      })
      .select({ normalisedValue: 1, bouncedAt: 1, optIn: 1 })
      .lean()
      .exec();

    return new Map(
      rows.map((row) => [
        row.normalisedValue,
        // A refusal is reported ahead of a bounce: it is the one the operator
        // must never override, and a bounced address they may simply re-verify.
        row.optIn === false ? 'consent_withdrawn' : 'bounced',
      ]),
    );
  }

  /** "Does this contact have anything we could send to", as an aggregation expression. */
  private hasDestinationExpression(
    channel: CampaignChannel,
  ): Record<string, unknown> {
    const nonEmpty = (path: string) => ({
      $gt: [{ $size: { $ifNull: [path, []] } }, 0],
    });

    if (channel === 'email') return nonEmpty('$emails');
    if (channel === 'sms') return nonEmpty('$phones');
    return {
      $or: [
        nonEmpty('$phones'),
        {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ['$omniIdentities', []] },
                  cond: { $eq: ['$$this.channelType', 'whatsapp'] },
                },
              },
            },
            0,
          ],
        },
      ],
    };
  }
}

const eq = (left: string, right: string) => ({ $eq: [left, right] });
