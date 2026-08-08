import { CampaignAudienceService } from './campaign-audience.service';
import { AudienceContact } from './campaign-audience.service';

/**
 * `decide` is where a campaign becomes correct or becomes an incident: it is the
 * single place that says who gets a message and who does not. Exercised directly
 * against stub models, because the rules it encodes â€” consent outranks data
 * quality, one message per address â€” are not observable from an integration test
 * without sending real traffic.
 */
describe('CampaignAudienceService.decide', () => {
  /** Identities the bounce/opt-out lookup will return. */
  function makeService(blocked: Array<Record<string, unknown>> = []) {
    const identities = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(blocked),
          }),
        }),
      }),
    };
    return new CampaignAudienceService({} as any, identities as any, {} as any);
  }

  const contact = (overrides: Partial<AudienceContact>): AudienceContact => ({
    _id: overrides._id ?? '1',
    ...overrides,
  });

  it('should resolve a normalised email destination', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', emails: ['  Sara@Example.COM '] })],
      'email',
      new Set(),
    );
    expect(decision).toEqual({
      contactId: 'a',
      destination: 'sara@example.com',
      skipReason: null,
    });
  });

  it('should skip a contact with no address for the channel', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', emails: [] })],
      'email',
      new Set(),
    );
    expect(decision.skipReason).toBe('no_destination');
    expect(decision.destination).toBeNull();
  });

  /**
   * A national number would be rejected by the gateway on every send. Refusing
   * it here turns a wall of identical provider errors into one actionable
   * "these numbers need country codes".
   */
  it('should refuse a phone that is not in E.164', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', phones: ['0901112222'] })],
      'sms',
      new Set(),
    );
    expect(decision.skipReason).toBe('invalid_destination');
  });

  it('should accept an E.164 phone', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', phones: ['+84 90 111 2222'] })],
      'sms',
      new Set(),
    );
    expect(decision.destination).toBe('+84901112222');
  });

  /** `doNotCall` is an explicit refusal and outranks a missing number. */
  it('should skip doNotCall on phone channels before looking for a number', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', phones: [], doNotCall: true })],
      'sms',
      new Set(),
    );
    expect(decision.skipReason).toBe('opted_out');
  });

  it('should not apply doNotCall to email', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', emails: ['x@y.com'], doNotCall: true })],
      'email',
      new Set(),
    );
    expect(decision.skipReason).toBeNull();
  });

  /**
   * The provider hands us the MSISDN as bare digits. Applying the strict E.164
   * rule to it would skip every WhatsApp contact resolved from a real inbound
   * message â€” which is most of them.
   */
  it('should prefer the WhatsApp identity over a typed phone, and restore its +', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [
        contact({
          _id: 'a',
          phones: ['+966500000000'],
          omniIdentities: [
            { channelType: 'whatsapp', senderId: '966501234567' },
          ],
        }),
      ],
      'whatsapp',
      new Set(),
    );
    expect(decision.destination).toBe('+966501234567');
  });

  it('should skip an address that previously hard-bounced', async () => {
    const service = makeService([
      {
        normalisedValue: 'sara@example.com',
        bouncedAt: new Date(),
        optIn: null,
      },
    ]);
    const [decision] = await service.decide(
      [contact({ _id: 'a', emails: ['sara@example.com'] })],
      'email',
      new Set(),
    );
    expect(decision.skipReason).toBe('bounced');
  });

  /**
   * `optIn: false` is a recorded refusal, unlike `optIn: null` which only means
   * nobody ever asked. A refusal is reported ahead of a bounce because it is the
   * one an operator must never work around.
   */
  it('should report an explicit refusal ahead of a bounce', async () => {
    const service = makeService([
      {
        normalisedValue: 'sara@example.com',
        bouncedAt: new Date(),
        optIn: false,
      },
    ]);
    const [decision] = await service.decide(
      [contact({ _id: 'a', emails: ['sara@example.com'] })],
      'email',
      new Set(),
    );
    expect(decision.skipReason).toBe('consent_withdrawn');
  });

  // ── Channel consent ────────────────────────────────────────────────
  // The regression these pin is the one that made the feature a compliance
  // problem: `emailOptIn` was a two-state flag, `false` was indistinguishable
  // from "never asked", so nothing enforced it and unsubscribing did not stop
  // the next campaign.

  it('should refuse a contact who said no to this channel', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', emails: ['x@y.com'], emailOptIn: false })],
      'email',
      new Set(),
    );
    expect(decision.skipReason).toBe('consent_withdrawn');
    expect(decision.destination).toBeNull();
  });

  /**
   * `null` is "nobody asked", and a tenant that has just imported its contacts
   * has asked nobody. Treating it as a refusal would send the first campaign of
   * every new account to zero people.
   */
  it('should still send when consent was never recorded', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [contact({ _id: 'a', emails: ['x@y.com'], emailOptIn: null })],
      'email',
      new Set(),
    );
    expect(decision.skipReason).toBeNull();
  });

  /** Consent is per channel: refusing SMS says nothing about email. */
  it('should read the consent flag belonging to the channel being sent', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [
        contact({
          _id: 'a',
          emails: ['x@y.com'],
          phones: ['+966500000000'],
          smsOptIn: false,
          emailOptIn: true,
        }),
      ],
      'email',
      new Set(),
    );
    expect(decision.skipReason).toBeNull();
  });

  /** A blanket refusal outranks a per-channel one, and is reported as its own. */
  it('should report doNotCall as opted_out, not as withdrawn consent', async () => {
    const service = makeService();
    const [decision] = await service.decide(
      [
        contact({
          _id: 'a',
          phones: ['+966500000000'],
          doNotCall: true,
          smsOptIn: false,
        }),
      ],
      'sms',
      new Set(),
    );
    expect(decision.skipReason).toBe('opted_out');
  });

  it('should send one message per address when two contacts share it', async () => {
    const service = makeService();
    const seen = new Set<string>();
    const decisions = await service.decide(
      [
        contact({ _id: 'a', emails: ['shared@example.com'] }),
        contact({ _id: 'b', emails: ['SHARED@example.com'] }),
      ],
      'email',
      seen,
    );
    expect(decisions[0].skipReason).toBeNull();
    expect(decisions[1].skipReason).toBe('duplicate');
  });

  it('should carry deduplication across batches', async () => {
    const service = makeService();
    const seen = new Set<string>();
    await service.decide(
      [contact({ _id: 'a', emails: ['x@y.com'] })],
      'email',
      seen,
    );
    const [second] = await service.decide(
      [contact({ _id: 'b', emails: ['x@y.com'] })],
      'email',
      seen,
    );
    expect(second.skipReason).toBe('duplicate');
  });
});
