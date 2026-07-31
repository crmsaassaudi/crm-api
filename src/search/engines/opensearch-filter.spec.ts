import { mongoAuthorizationFilterToDsl } from './opensearch-filter';

describe('mongoAuthorizationFilterToDsl', () => {
  it('should preserve deny filters without widening access', () => {
    expect(
      mongoAuthorizationFilterToDsl({
        $nor: [{ statusId: { $in: ['private'] } }],
      }),
    ).toEqual({
      bool: {
        must_not: [{ terms: { statusId: ['private'] } }],
      },
    });
  });
});
