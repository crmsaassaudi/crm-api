import { ServiceUnavailableException } from '@nestjs/common';
import { compileAbacDenyFilter } from './abac-query.compiler';

describe('compileAbacDenyFilter', () => {
  it('should compile applicable resource denies with subject values', () => {
    expect(
      compileAbacDenyFilter(
        [
          {
            effect: 'deny',
            conditions: [
              {
                attribute: 'subject.principalType',
                operator: 'eq',
                value: 'user',
              },
              {
                attribute: 'resource.ownerId',
                operator: 'ne',
                valueAttribute: 'subject.id',
              },
              {
                attribute: 'resource.stage',
                operator: 'in',
                value: ['closed', 'lost'],
              },
            ],
          },
        ],
        { subject: { id: 'u1', principalType: 'user' } },
      ),
    ).toEqual({
      $nor: [
        {
          $and: [
            { ownerId: { $ne: 'u1' } },
            { stage: { $in: ['closed', 'lost'] } },
          ],
        },
      ],
    });
  });

  it('should skip a deny whose subject/environment preconditions do not apply', () => {
    expect(
      compileAbacDenyFilter(
        [
          {
            effect: 'deny',
            conditions: [
              {
                attribute: 'subject.principalType',
                operator: 'eq',
                value: 'automation',
              },
              {
                attribute: 'resource.secret',
                operator: 'eq',
                value: true,
              },
            ],
          },
        ],
        { subject: { principalType: 'user' } },
      ),
    ).toBeNull();
  });

  it('should not use allow policies to widen the positive row scope', () => {
    expect(
      compileAbacDenyFilter(
        [
          {
            effect: 'allow',
            conditions: [
              {
                attribute: 'resource.ownerId',
                operator: 'eq',
                value: 'other',
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });

  it('should fail closed for resource-to-resource comparisons', () => {
    expect(() =>
      compileAbacDenyFilter(
        [
          {
            effect: 'deny',
            conditions: [
              {
                attribute: 'resource.ownerId',
                operator: 'ne',
                valueAttribute: 'resource.createdById',
              },
            ],
          },
        ],
        {},
      ),
    ).toThrow(ServiceUnavailableException);
  });
});
