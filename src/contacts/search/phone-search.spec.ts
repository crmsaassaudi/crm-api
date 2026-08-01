import { buildPhoneSearchPrefixes, phoneSearchClause } from './phone-search';

describe('buildPhoneSearchPrefixes — deciding what is a phone', () => {
  it('should reject a term containing letters so names keep going to text search', () => {
    expect(buildPhoneSearchPrefixes('nguyen van')).toBeNull();
    expect(buildPhoneSearchPrefixes('Nguyen 0901')).toBeNull();
  });

  it('should reject a term with fewer digits than a recognisable fragment', () => {
    expect(buildPhoneSearchPrefixes('123')).toBeNull();
  });

  it('should accept the separators every UI and CSV puts in a number', () => {
    expect(buildPhoneSearchPrefixes('+84 (912) 345-678')).toEqual([
      '+84912345678',
    ]);
    expect(buildPhoneSearchPrefixes('0912.345.678')).toContain('0912345678');
  });

  it('should not invent national variants when the caller supplied a "+"', () => {
    // An explicit '+' is a statement about the format. Adding bare-digit or
    // country-code-promoted variants would widen an unambiguous query.
    expect(buildPhoneSearchPrefixes('+84912345678', '84')).toEqual([
      '+84912345678',
    ]);
  });

  it('should bridge the national form a user types to the E.164 form stored', () => {
    // The case this whole branch exists for: the write gate normalised to
    // +84912345678 and the agent types the number they know.
    const prefixes = buildPhoneSearchPrefixes('0912345678', '84');
    expect(prefixes).toContain('+84912345678');
  });

  it('should still work without a country code, minus the national bridge', () => {
    const prefixes = buildPhoneSearchPrefixes('0912345678');
    expect(prefixes).toContain('0912345678');
    expect(prefixes).toContain('+0912345678');
    expect(prefixes).not.toContain('+84912345678');
  });

  it('should support partial typing as a prefix', () => {
    expect(buildPhoneSearchPrefixes('0912')).toContain('0912');
  });
});

describe('phoneSearchClause — staying index-usable', () => {
  it('should anchor every regex and never set the case-insensitive option', () => {
    // Both properties are what let MongoDB use `tenant_phone_lookup`: only an
    // anchored, case-sensitive prefix expression can be matched against index
    // keys. An `$options: 'i'` here silently turns this into a tenant-wide scan.
    const clause = phoneSearchClause(['0912345678', '+84912345678']) as any;
    const branches = clause.$or as Array<{ phones: { $regex: string } }>;
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.phones.$regex.startsWith('^')).toBe(true);
      expect(branch.phones).not.toHaveProperty('$options');
    }
  });

  it('should escape regex metacharacters coming from the "+" prefix', () => {
    const clause = phoneSearchClause(['+84912345678']) as any;
    expect(clause.phones.$regex).toBe('^\\+84912345678');
  });

  it('should emit a bare clause rather than a one-armed $or', () => {
    const clause = phoneSearchClause(['0912345678']) as any;
    expect(clause.$or).toBeUndefined();
    expect(clause.phones.$regex).toBe('^0912345678');
  });
});
