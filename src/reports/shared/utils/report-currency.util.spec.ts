import { detectCurrencyMix } from './report-currency.util';

const model = (result: unknown[] | Error) =>
  ({
    distinct: jest.fn(() =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
    ),
  }) as any;

describe('detectCurrencyMix', () => {
  it('should stay silent for a single-currency tenant', async () => {
    // The common case. It must not acquire a warning it does not deserve, or every
    // report grows a banner nobody reads.
    const mix = await detectCurrencyMix(model(['USD']), {});
    expect(mix).toEqual({ currencies: ['USD'], isMixed: false });
    expect(mix.warning).toBeUndefined();
  });

  it('should stay silent when no deal has a currency', async () => {
    expect(await detectCurrencyMix(model([]), {})).toEqual({
      currencies: [],
      isMixed: false,
    });
  });

  it('should warn when totals span more than one currency', async () => {
    // `$sum: '$value'` over USD and VND is the arithmetic sum of unlike units, and at
    // ~24,000 VND to the dollar one VND deal dominates the total.
    const mix = await detectCurrencyMix(model(['USD', 'VND']), {});
    expect(mix.isMixed).toBe(true);
    expect(mix.warning).toContain('2 currencies');
    expect(mix.warning).toContain('USD, VND');
  });

  it('should fold case and whitespace variants of the same currency', async () => {
    // `'usd'`, `' USD '` and `'USD'` are one currency. Treating them as three would
    // warn a single-currency tenant about a problem they do not have.
    const mix = await detectCurrencyMix(model(['usd', ' USD ', 'USD']), {});
    expect(mix.currencies).toEqual(['USD']);
    expect(mix.isMixed).toBe(false);
  });

  it('should ignore empty and non-string values', async () => {
    const mix = await detectCurrencyMix(
      model(['USD', '', '   ', null, 42]),
      {},
    );
    expect(mix.currencies).toEqual(['USD']);
    expect(mix.isMixed).toBe(false);
  });

  it('should return currencies sorted, so the warning text is stable', async () => {
    // An unstable message would churn snapshots and look like a changing problem.
    const mix = await detectCurrencyMix(model(['VND', 'EUR', 'USD']), {});
    expect(mix.currencies).toEqual(['EUR', 'USD', 'VND']);
  });

  it('should summarise rather than enumerate a long currency list', async () => {
    const many = ['AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'USD', 'VND'];
    const mix = await detectCurrencyMix(model(many), {});
    expect(mix.warning).toContain('8 currencies');
    expect(mix.warning).toContain('2 more');
  });

  it('should pass the report match through so the check covers the same rows', async () => {
    // Detecting across the whole collection while the report sums a filtered subset
    // would warn about currencies the total does not actually include.
    const m = model(['USD']);
    const match = { tenantId: 't1', stageId: 's1' };
    await detectCurrencyMix(m, match);
    expect(m.distinct).toHaveBeenCalledWith('currency', match);
  });

  it('should never fail the report when the check itself fails', async () => {
    // And must not warn spuriously: the totals are exactly as trustworthy as they
    // were before this check existed.
    const mix = await detectCurrencyMix(model(new Error('mongo down')), {});
    expect(mix).toEqual({ currencies: [], isMixed: false });
  });
});
