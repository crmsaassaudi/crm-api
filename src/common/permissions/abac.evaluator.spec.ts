import {
  evaluateCondition,
  policyApplies,
  evaluatePolicies,
  AbacContext,
} from './abac.evaluator';

describe('ABAC evaluator', () => {
  const ctx: AbacContext = {
    subject: { id: 'u1', roleIds: ['sales', 'support'], principalType: 'user' },
    resource: {
      ownerId: 'u1',
      stage: 'closed',
      amount: 5000,
      tags: ['vip', 'renewal'],
    },
    env: { now: new Date('2026-07-24T12:00:00.000Z') },
  };

  describe('evaluateCondition', () => {
    it('eq / ne with literal and valueAttribute', () => {
      expect(
        evaluateCondition(
          { attribute: 'resource.stage', operator: 'eq', value: 'closed' },
          ctx,
        ),
      ).toBe(true);
      // ownership: resource.ownerId eq subject.id
      expect(
        evaluateCondition(
          {
            attribute: 'resource.ownerId',
            operator: 'eq',
            valueAttribute: 'subject.id',
          },
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          { attribute: 'resource.stage', operator: 'ne', value: 'open' },
          ctx,
        ),
      ).toBe(true);
    });

    it('in / nin against arrays', () => {
      expect(
        evaluateCondition(
          {
            attribute: 'resource.stage',
            operator: 'in',
            value: ['won', 'closed'],
          },
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          {
            attribute: 'subject.principalType',
            operator: 'nin',
            value: ['agent', 'service'],
          },
          ctx,
        ),
      ).toBe(true);
    });

    it('numeric comparisons', () => {
      expect(
        evaluateCondition(
          { attribute: 'resource.amount', operator: 'gt', value: 1000 },
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          { attribute: 'resource.amount', operator: 'lte', value: 5000 },
          ctx,
        ),
      ).toBe(true);
      // type mismatch → false, never throws
      expect(
        evaluateCondition(
          { attribute: 'resource.stage', operator: 'gt', value: 3 },
          ctx,
        ),
      ).toBe(false);
    });

    it('contains on arrays and strings', () => {
      expect(
        evaluateCondition(
          { attribute: 'resource.tags', operator: 'contains', value: 'vip' },
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          { attribute: 'subject.roleIds', operator: 'contains', value: 'admin' },
          ctx,
        ),
      ).toBe(false);
    });

    it('exists', () => {
      expect(
        evaluateCondition(
          { attribute: 'resource.ownerId', operator: 'exists', value: true },
          ctx,
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          { attribute: 'resource.missing', operator: 'exists', value: false },
          ctx,
        ),
      ).toBe(true);
    });

    it('missing attribute paths never throw and fail the condition', () => {
      expect(
        evaluateCondition(
          { attribute: 'resource.deep.nope', operator: 'eq', value: 1 },
          ctx,
        ),
      ).toBe(false);
      expect(
        evaluateCondition(
          { attribute: 'nonsense.path', operator: 'eq', value: 1 },
          {},
        ),
      ).toBe(false);
    });
  });

  describe('policyApplies (AND semantics)', () => {
    it('requires all conditions to hold; empty = always applies', () => {
      expect(policyApplies({ effect: 'deny', conditions: [] }, ctx)).toBe(true);
      expect(
        policyApplies(
          {
            effect: 'deny',
            conditions: [
              { attribute: 'resource.stage', operator: 'eq', value: 'closed' },
              { attribute: 'resource.amount', operator: 'gt', value: 1000 },
            ],
          },
          ctx,
        ),
      ).toBe(true);
      expect(
        policyApplies(
          {
            effect: 'deny',
            conditions: [
              { attribute: 'resource.stage', operator: 'eq', value: 'closed' },
              { attribute: 'resource.amount', operator: 'gt', value: 9999 },
            ],
          },
          ctx,
        ),
      ).toBe(false);
    });
  });

  describe('evaluatePolicies (deny-overrides)', () => {
    it('deny wins over allow', () => {
      const effect = evaluatePolicies(
        [
          { effect: 'allow', conditions: [] },
          {
            effect: 'deny',
            conditions: [
              { attribute: 'resource.stage', operator: 'eq', value: 'closed' },
            ],
          },
        ],
        ctx,
      );
      expect(effect).toBe('deny');
    });

    it('allow when only allow policies apply', () => {
      expect(
        evaluatePolicies(
          [
            {
              effect: 'allow',
              conditions: [
                {
                  attribute: 'resource.ownerId',
                  operator: 'eq',
                  valueAttribute: 'subject.id',
                },
              ],
            },
          ],
          ctx,
        ),
      ).toBe('allow');
    });

    it('null when no policy applies', () => {
      expect(
        evaluatePolicies(
          [
            {
              effect: 'deny',
              conditions: [
                { attribute: 'resource.stage', operator: 'eq', value: 'open' },
              ],
            },
          ],
          ctx,
        ),
      ).toBeNull();
    });
  });
});
