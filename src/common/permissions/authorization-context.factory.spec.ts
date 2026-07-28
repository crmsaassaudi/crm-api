import { AuthorizationContextFactory } from './authorization-context.factory';

describe('AuthorizationContextFactory', () => {
  const factory = new AuthorizationContextFactory();

  it('builds the same canonical subject shape for action and record decisions', () => {
    const subject = {
      tenantId: 't1',
      userId: 'u1',
      principalType: 'automation',
      groupIds: ['g1', 'g1'],
      attributes: { department: 'sales' },
    };

    const action = factory.forAction(subject, {
      now: new Date('2026-07-28T12:00:00Z'),
      ip: '10.0.0.1',
    });
    const record = factory.forRecord(
      subject,
      'r1',
      { ownerId: 'u1' },
      {
        now: new Date('2026-07-28T12:00:00Z'),
        ip: '10.0.0.1',
      },
    );

    expect(record.subject).toEqual(action.subject);
    expect(record.env).toEqual(action.env);
    expect(action.subject?.groupIds).toEqual(['g1']);
  });

  it('does not allow supplemental attributes to spoof trusted fields', () => {
    const context = factory.forRecord(
      {
        tenantId: 'trusted-tenant',
        userId: 'trusted-user',
        groupIds: ['trusted-group'],
        attributes: {
          id: 'attacker',
          tenantId: 'other-tenant',
          groupIds: ['attacker-group'],
        },
      },
      'trusted-record',
      { id: 'attacker-record' },
      {
        now: new Date('2026-07-28T12:00:00Z'),
        attributes: { now: new Date('1999-01-01T00:00:00Z') },
      },
    );

    expect(context.subject).toEqual(
      expect.objectContaining({
        id: 'trusted-user',
        tenantId: 'trusted-tenant',
        groupIds: ['trusted-group'],
      }),
    );
    expect(context.resource?.id).toBe('trusted-record');
    expect(context.env?.now).toEqual(new Date('2026-07-28T12:00:00Z'));
  });
});
