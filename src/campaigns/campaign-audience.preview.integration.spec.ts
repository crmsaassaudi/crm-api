import { Connection, Model, Types } from 'mongoose';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from '../test/integration-setup';
import { runWithTenant } from '../test/helpers/cls-context.helper';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { CampaignAudienceService } from './campaign-audience.service';

/**
 * The preview counts people with an aggregation, and an aggregation expression
 * is something Mongo only judges at execution time. A malformed `$switch` or a
 * `$not` handed the wrong argument shape passes `tsc`, passes every mocked unit
 * test, and then fails on the first real preview a customer runs.
 *
 * Run against a real database for a second reason too: the numbers have to
 * PARTITION. `reachable + noDestination + refused` must equal `total` for every
 * channel, or the panel subtracts figures that do not add up and the marketer
 * stops trusting it.
 */
describe('CampaignAudienceService.preview (integration)', () => {
  let connection: Connection;
  let contacts: Model<any>;
  let service: CampaignAudienceService;

  const tenantId = new Types.ObjectId().toString();

  /** One contact per case the bucketing has to tell apart. */
  const FIXTURES = [
    { name: 'email, never asked', emails: ['a@b.com'] },
    { name: 'email, agreed', emails: ['c@d.com'], emailOptIn: true },
    { name: 'email, REFUSED', emails: ['e@f.com'], emailOptIn: false },
    { name: 'empty email array', emails: [] },
    { name: 'no email field at all' },
    { name: 'phone only', phones: ['+966500000000'] },
    { name: 'phone but doNotCall', phones: ['+966500000001'], doNotCall: true },
    { name: 'phone, SMS refused', phones: ['+966500000002'], smsOptIn: false },
    {
      name: 'whatsapp identity only',
      omniIdentities: [{ channelType: 'whatsapp', senderId: '966500000003' }],
    },
    {
      name: 'omni identity on another channel',
      omniIdentities: [{ channelType: 'facebook', senderId: 'fb_1' }],
    },
  ];

  beforeAll(async () => {
    connection = await setupTestDatabase();
    contacts = connection.model(
      ContactSchemaClass.name,
      ContactSchema,
    ) as unknown as Model<any>;

    // Only the contact model is exercised: identity lookups and audience
    // resolution belong to `decide` and `ContactAudienceService`, which have
    // their own tests.
    service = new CampaignAudienceService(
      contacts as any,
      {} as any,
      {} as any,
    );
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  const seed = () =>
    runWithTenant(tenantId, async () => {
      await contacts.insertMany(
        FIXTURES.map((fixture) => ({
          ...fixture,
          firstName: fixture.name,
          lastName: 'probe',
          tenantId: new Types.ObjectId(tenantId),
          createdById: new Types.ObjectId(),
          updatedById: new Types.ObjectId(),
        })),
      );
    });

  const preview = (channel: 'email' | 'sms' | 'whatsapp') =>
    runWithTenant(tenantId, () =>
      service.preview({ deletedAt: null }, channel),
    );

  it('should count an email audience, splitting refusal from missing address', async () => {
    await seed();
    const result = await preview('email');

    expect(result).toEqual({
      total: 10,
      // The two with a usable address who have not refused.
      reachable: 2,
      noDestination: 7,
      refused: 1,
      // Of the reachable two, one has never been asked.
      consentUnknown: 1,
      exact: true,
    });
  });

  /** `doNotCall` and a channel refusal are both refusals, and both are counted. */
  it('should count doNotCall and a channel refusal together on SMS', async () => {
    await seed();
    const result = await preview('sms');

    expect(result.refused).toBe(2);
    expect(result.reachable).toBe(1);
  });

  /**
   * Consent is per channel. Refusing SMS says nothing about WhatsApp, and the
   * contact stays reachable there — the regression a single shared opt-out flag
   * would reintroduce.
   */
  it('should not let an SMS refusal exclude someone from WhatsApp', async () => {
    await seed();
    const result = await preview('whatsapp');

    expect(result.reachable).toBe(3);
    expect(result.refused).toBe(1);
  });

  /** A WhatsApp identity is a destination even with no phone number typed in. */
  it('should treat a WhatsApp identity as a destination', async () => {
    await runWithTenant(tenantId, async () => {
      await contacts.create({
        firstName: 'identity only',
        lastName: 'probe',
        omniIdentities: [{ channelType: 'whatsapp', senderId: '966500000009' }],
        tenantId: new Types.ObjectId(tenantId),
        createdById: new Types.ObjectId(),
        updatedById: new Types.ObjectId(),
      });
    });

    expect((await preview('whatsapp')).reachable).toBe(1);
    // ...and is not one for SMS, which needs an actual number.
    expect((await preview('sms')).noDestination).toBe(1);
  });

  it.each(['email', 'sms', 'whatsapp'] as const)(
    'should produce figures that add up on %s',
    async (channel) => {
      await seed();
      const result = await preview(channel);

      expect(result.reachable + result.noDestination + result.refused).toBe(
        result.total,
      );
      expect(result.consentUnknown).toBeLessThanOrEqual(result.reachable);
    },
  );

  /** An audience matching nobody returns zeroes, not a crash on a missing row. */
  it('should return zeroes for an audience that matches nobody', async () => {
    await seed();
    const result = await runWithTenant(tenantId, () =>
      service.preview({ _id: { $in: [] } }, 'email'),
    );

    expect(result).toEqual({
      total: 0,
      reachable: 0,
      noDestination: 0,
      refused: 0,
      consentUnknown: 0,
      exact: true,
    });
  });

  /** The tenant plugin narrows the aggregation, not just the finds. */
  it('should not count another tenant’s contacts', async () => {
    await seed();
    const otherTenant = new Types.ObjectId().toString();

    expect((await preview('email')).total).toBe(10);
    expect(
      (
        await runWithTenant(otherTenant, () =>
          service.preview({ deletedAt: null }, 'email'),
        )
      ).total,
    ).toBe(0);
  });
});
