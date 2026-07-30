import {
  canServeFromRollup,
  type RollupContextShape,
  type RollupRequestShape,
} from './can-serve-from-rollup';

const context = (
  overrides: Partial<RollupContextShape> = {},
): RollupContextShape => ({
  visibleOwnerIds: null,
  hasAbacFilter: false,
  rollupCoveredThrough: '2026-07-28',
  requestedThrough: '2026-07-28',
  enabled: true,
  ...overrides,
});

const request = (overrides: RollupRequestShape = {}): RollupRequestShape =>
  overrides;

/**
 * This predicate is the correctness boundary of the rollup: a wrong `true` returns
 * plausible-looking wrong numbers, which is worse than the slow query it replaces.
 * Every refusal below is a case where the pre-aggregated rows genuinely cannot
 * answer the question.
 */
describe('canServeFromRollup — serves', () => {
  it('should serve an unfiltered request within the covered range', () => {
    expect(canServeFromRollup(request(), context())).toEqual({
      canServe: true,
    });
  });

  it('should serve an owner-restricted request', () => {
    // ownerId is a rollup DIMENSION, so the visibility predicate applies to the
    // buckets and gives the identical answer. Without this the rollup would only
    // ever help an unrestricted admin.
    expect(
      canServeFromRollup(request(), context({ visibleOwnerIds: ['u1', 'u2'] })),
    ).toEqual({ canServe: true });
  });

  it('should serve a request ending before the covered day', () => {
    expect(
      canServeFromRollup(
        request(),
        context({ requestedThrough: '2026-06-30' }),
      ),
    ).toEqual({ canServe: true });
  });

  it('should serve a restricted request with an empty owner list', () => {
    // An empty list is a legitimate "sees nothing" scope, not a missing value —
    // summing zero buckets is the right answer.
    expect(
      canServeFromRollup(request(), context({ visibleOwnerIds: [] })),
    ).toEqual({ canServe: true });
  });
});

describe('canServeFromRollup — refuses on unsupported filters', () => {
  it.each([
    ['sourceId', { sourceId: 'src1' }, 'filter:sourceId'],
    ['channel', { channel: 'whatsapp' }, 'filter:channel'],
    ['isVIP true', { isVIP: true }, 'filter:isVIP'],
    // `false` is still a filter — it excludes VIPs, which the rollup cannot do.
    ['isVIP false', { isVIP: false }, 'filter:isVIP'],
    ['includeDeleted', { includeDeleted: true }, 'filter:includeDeleted'],
  ])('should refuse when %s is set', (_label, req, reason) => {
    expect(canServeFromRollup(req as RollupRequestShape, context())).toEqual({
      canServe: false,
      reason,
    });
  });

  it('should refuse a stage filter — stage is not fixed at creation time', () => {
    // A creation-day bucket keyed by CURRENT stage would retroactively rewrite
    // history every time someone advanced a lifecycle stage.
    expect(
      canServeFromRollup(request({ stageId: 'customer' }), context()),
    ).toEqual({ canServe: false, reason: 'filter:stageId' });
  });
});

describe('canServeFromRollup — refuses on visibility it cannot express', () => {
  it('should refuse when an ABAC predicate applies', () => {
    // An arbitrary compiled row filter cannot be reduced to owner/orgUnit buckets,
    // and guessing would leak rows.
    expect(
      canServeFromRollup(request(), context({ hasAbacFilter: true })),
    ).toEqual({ canServe: false, reason: 'abac-predicate' });
  });

  it('should refuse when visibility was never evaluated', () => {
    // A cron or system caller. Keeps the rollup strictly a request-path optimisation.
    expect(
      canServeFromRollup(request(), context({ visibleOwnerIds: undefined })),
    ).toEqual({ canServe: false, reason: 'visibility-not-evaluated' });
  });
});

describe('canServeFromRollup — refuses on freshness', () => {
  it('should refuse a range extending past the computed days', () => {
    // Serving it would silently report ZERO for the uncovered days — the failure
    // that makes a stale rollup dangerous rather than merely stale.
    expect(
      canServeFromRollup(
        request(),
        context({
          rollupCoveredThrough: '2026-07-20',
          requestedThrough: '2026-07-28',
        }),
      ),
    ).toEqual({ canServe: false, reason: 'range-not-covered' });
  });

  it('should refuse when the rollup is empty', () => {
    expect(
      canServeFromRollup(request(), context({ rollupCoveredThrough: null })),
    ).toEqual({ canServe: false, reason: 'range-not-covered' });
  });

  it('should compare days lexicographically, which YYYY-MM-DD makes valid', () => {
    // The string form is chosen so this comparison needs no date maths; a format
    // change would break it silently, so it is pinned here.
    expect(
      canServeFromRollup(
        request(),
        context({
          rollupCoveredThrough: '2026-09-01',
          requestedThrough: '2026-10-01',
        }),
      ).canServe,
    ).toBe(false);
    expect(
      canServeFromRollup(
        request(),
        context({
          rollupCoveredThrough: '2026-10-01',
          requestedThrough: '2026-09-01',
        }),
      ).canServe,
    ).toBe(true);
  });
});

describe('canServeFromRollup — kill switch', () => {
  it('should refuse everything when disabled', () => {
    // One env var has to be able to take the rollup out of the read path without a
    // deploy, if it is ever found to disagree with the live query.
    expect(canServeFromRollup(request(), context({ enabled: false }))).toEqual({
      canServe: false,
      reason: 'disabled',
    });
  });

  it('should check the kill switch before anything else', () => {
    expect(
      canServeFromRollup(request({ isVIP: true }), context({ enabled: false }))
        .reason,
    ).toBe('disabled');
  });
});
