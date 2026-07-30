import { resolveSurvivorship } from './contact-survivorship';
import { Contact } from '../domain/contact';

const contact = (overrides: Partial<Contact> = {}): Contact =>
  ({
    id: 'c1',
    tenantId: 't1',
    firstName: 'Alice',
    lastName: 'Nguyen',
    emails: [],
    phones: [],
    tags: [],
    omniIdentities: [],
    stageHistory: [],
    lifecycleStageId: 'lead',
    statusId: 'new',
    createdById: 'u1',
    updatedById: 'u1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  }) as Contact;

describe('resolveSurvivorship — identity arrays', () => {
  it('should union emails and phones rather than choosing one side', () => {
    const { update } = resolveSurvivorship(
      contact({ emails: ['a@x.com'], phones: ['+84901112222'] }),
      contact({ emails: ['b@x.com'], phones: ['+84903334444'] }),
    );
    expect(update.emails).toEqual(['a@x.com', 'b@x.com']);
    expect(update.phones).toEqual(['+84901112222', '+84903334444']);
  });

  it('should not lose an identity that only the merged-away contact had', () => {
    const { update } = resolveSurvivorship(
      contact({ emails: [] }),
      contact({ emails: ['only@x.com'] }),
    );
    expect(update.emails).toEqual(['only@x.com']);
  });

  it('should de-duplicate omniIdentities by channel + sender', () => {
    const shared = { channelType: 'facebook', senderId: 'psid_1' };
    const { update } = resolveSurvivorship(
      contact({ omniIdentities: [shared] }),
      contact({
        omniIdentities: [shared, { channelType: 'zalo', senderId: 'z_9' }],
      }),
    );
    expect(update.omniIdentities).toEqual([
      shared,
      { channelType: 'zalo', senderId: 'z_9' },
    ]);
  });
});

describe('resolveSurvivorship — scalars', () => {
  it('should fill a blank on the survivor from the merged contact', () => {
    const { update, choices } = resolveSurvivorship(
      contact({ title: undefined }),
      contact({ title: 'CTO' }),
    );
    expect(update.title).toBe('CTO');
    expect(choices.title).toEqual({ chosen: 'CTO', from: 'merged' });
  });

  it('should keep the survivor value and RECORD what was discarded', () => {
    const { update, choices } = resolveSurvivorship(
      contact({ title: 'CEO' }),
      contact({ title: 'CTO' }),
    );
    expect(update.title).toBeUndefined();
    expect(choices.title).toEqual({
      chosen: 'CEO',
      from: 'survivor',
      discarded: 'CTO',
    });
  });

  it('should honour an explicit field winner from the merge dialog', () => {
    const { update, choices } = resolveSurvivorship(
      contact({ firstName: 'Al' }),
      contact({ firstName: 'Alice' }),
      { fieldWinners: { firstName: 'merged' } },
    );
    expect(update.firstName).toBe('Alice');
    expect(choices.firstName).toEqual({
      chosen: 'Alice',
      from: 'merged',
      discarded: 'Al',
    });
  });

  it('should treat whitespace and empty arrays as blank', () => {
    const { update } = resolveSurvivorship(
      contact({ companyName: '   ' }),
      contact({ companyName: 'Acme' }),
    );
    expect(update.companyName).toBe('Acme');
  });
});

describe('resolveSurvivorship — consent', () => {
  // A merge is data cleanup. It must never end up with permission to contact
  // someone that neither source record carried.
  it('should NOT manufacture email consent from one side only', () => {
    const { update } = resolveSurvivorship(
      contact({ emailOptIn: true }),
      contact({ emailOptIn: false }),
    );
    expect(update.emailOptIn).toBe(false);
  });

  it('should keep consent when both records carry it', () => {
    const { update } = resolveSurvivorship(
      contact({ emailOptIn: true, smsOptIn: true }),
      contact({ emailOptIn: true, smsOptIn: true }),
    );
    expect(update.emailOptIn).toBe(true);
    expect(update.smsOptIn).toBe(true);
  });

  it('should keep a do-not-call restriction from either side', () => {
    const { update } = resolveSurvivorship(
      contact({ doNotCall: false }),
      contact({ doNotCall: true }),
    );
    expect(update.doNotCall).toBe(true);
  });
});

describe('resolveSurvivorship — derived fields', () => {
  it('should take the higher score and the later activity', () => {
    const { update } = resolveSurvivorship(
      contact({ score: 20, lastActivityAt: new Date('2026-01-01') }),
      contact({ score: 80, lastActivityAt: new Date('2026-06-01') }),
    );
    expect(update.score).toBe(80);
    expect(update.lastActivityAt).toEqual(new Date('2026-06-01'));
  });

  it('should promote out of shadow when either side is a real contact', () => {
    const { update } = resolveSurvivorship(
      contact({ isShadow: true }),
      contact({ isShadow: false }),
    );
    expect(update.isShadow).toBe(false);
  });

  it('should stay shadow only when both are shadow', () => {
    const { update } = resolveSurvivorship(
      contact({ isShadow: true }),
      contact({ isShadow: true }),
    );
    expect(update.isShadow).toBe(true);
  });

  it('should keep VIP from either side', () => {
    const { update } = resolveSurvivorship(
      contact({ isVIP: false }),
      contact({ isVIP: true }),
    );
    expect(update.isVIP).toBe(true);
  });

  it('should merge stage history into one chronological sequence', () => {
    const { update } = resolveSurvivorship(
      contact({
        stageHistory: [
          {
            fromStage: null,
            toStage: 'lead',
            changedAt: new Date('2026-01-01'),
            changedById: 'u1',
          },
        ],
      }),
      contact({
        stageHistory: [
          {
            fromStage: 'lead',
            toStage: 'customer',
            changedAt: new Date('2026-03-01'),
            changedById: 'u2',
          },
        ],
      }),
    );
    expect(update.stageHistory.map((h: any) => h.toStage)).toEqual([
      'lead',
      'customer',
    ]);
  });
});

describe('resolveSurvivorship — customFields', () => {
  it('should fill blanks per key without dropping either side', () => {
    const { update } = resolveSurvivorship(
      contact({ customFields: { budget: 100, region: null } }),
      contact({ customFields: { region: 'APAC', segment: 'SMB' } }),
    );
    expect(update.customFields).toEqual({
      budget: 100,
      region: 'APAC',
      segment: 'SMB',
    });
  });
});
