import {
  compareCompanyIdentity,
  deriveCompanyIdentity,
  normalizeCompanyName,
  normalizeTaxId,
  normalizeWebsiteDomain,
} from './company-identity';

describe('normalizeCompanyName', () => {
  it('should fold the three-Acmes case the audit opened with', () => {
    const keys = ['Acme Corp', 'ACME, Inc.', 'Acme Corporation'].map(
      normalizeCompanyName,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('acme');
  });

  it('should strip Vietnamese legal forms', () => {
    // A suffix list that only knew "Inc" and "Ltd" would match the English cases and
    // fail these — worse than matching neither, because it looks like it works.
    expect(normalizeCompanyName('Công ty TNHH Acme')).toBe('acme');
    expect(normalizeCompanyName('Công ty Cổ phần Acme')).toBe('acme');
    expect(normalizeCompanyName('Acme JSC')).toBe('acme');
  });

  it('should fold diacritics so the same name typed twice matches', () => {
    expect(normalizeCompanyName('Công ty Việt')).toBe(
      normalizeCompanyName('Cong ty Viet'),
    );
  });

  it('should handle đ, which has no combining form', () => {
    expect(normalizeCompanyName('Đông Á')).toBe('dong a');
  });

  it('should strip stacked suffixes', () => {
    expect(normalizeCompanyName('Acme Holdings Ltd')).toBe('acme');
  });

  it('should expand & so "A&B" and "A and B" agree', () => {
    expect(normalizeCompanyName('A&B')).toBe(normalizeCompanyName('A and B'));
  });

  it('should NOT reduce a name that is only a legal form to nothing', () => {
    // Stripping it would make every such record collide with every other.
    expect(normalizeCompanyName('Group')).toBe('group');
  });

  it('should return empty for junk input rather than something matchable', () => {
    expect(normalizeCompanyName('')).toBe('');
    expect(normalizeCompanyName('   ')).toBe('');
    expect(normalizeCompanyName(undefined as any)).toBe('');
  });
});

describe('normalizeWebsiteDomain', () => {
  it('should reduce any pasted form to the registrable domain', () => {
    for (const input of [
      'acme.com',
      'www.acme.com',
      'https://acme.com',
      'https://www.acme.com/about?x=1#top',
      'HTTP://ACME.COM:8080/',
      'acme.com.',
    ]) {
      expect(normalizeWebsiteDomain(input)).toBe('acme.com');
    }
  });

  it('should keep the organisation label under a two-label public suffix', () => {
    // `acme.com.vn` must not collapse to `com.vn`, which would match every Vietnamese
    // company at once.
    expect(normalizeWebsiteDomain('https://www.acme.com.vn/x')).toBe(
      'acme.com.vn',
    );
    expect(normalizeWebsiteDomain('acme.co.uk')).toBe('acme.co.uk');
  });

  it('should treat a subdomain as the same organisation', () => {
    expect(normalizeWebsiteDomain('careers.acme.com')).toBe('acme.com');
  });

  it('should strip credentials', () => {
    expect(normalizeWebsiteDomain('https://user:pw@acme.com/x')).toBe(
      'acme.com',
    );
  });

  it('should return empty rather than something that matches everything', () => {
    // A caller must never be able to read "could not parse" as "matches all".
    for (const input of ['', '   ', 'not a url', 'localhost', 'acme']) {
      expect(normalizeWebsiteDomain(input)).toBe('');
    }
  });

  it('should refuse an IP address, which is not a company identity', () => {
    expect(normalizeWebsiteDomain('http://192.168.1.1/app')).toBe('');
  });
});

describe('normalizeTaxId', () => {
  it('should strip formatting but keep the characters', () => {
    expect(normalizeTaxId('01-2345678')).toBe('012345678');
    expect(normalizeTaxId(' 0123 456 789 ')).toBe('0123456789');
    expect(normalizeTaxId('gb-123456789')).toBe('GB123456789');
  });

  it('should return empty for junk', () => {
    expect(normalizeTaxId('--')).toBe('');
    expect(normalizeTaxId(undefined as any)).toBe('');
  });
});

describe('compareCompanyIdentity — confidence tiers', () => {
  const identity = (a: { name?: string; website?: string; taxId?: string }) =>
    deriveCompanyIdentity(a);

  it('should call a shared tax ID EXACT — it is the same legal entity', () => {
    const match = compareCompanyIdentity(
      identity({ name: 'Acme', taxId: '01-2345678' }),
      identity({ name: 'Totally Different Ltd', taxId: '012345678' }),
    );
    expect(match).toEqual({ confidence: 'exact', matchedOn: 'taxId' });
  });

  it('should call a shared domain STRONG, not exact', () => {
    // Subsidiaries sometimes share a parent's domain, which is why this is not exact.
    const match = compareCompanyIdentity(
      identity({ name: 'Acme US', website: 'https://acme.com' }),
      identity({ name: 'Acme EU', website: 'www.acme.com/eu' }),
    );
    expect(match).toEqual({ confidence: 'strong', matchedOn: 'website' });
  });

  it('should call a shared name only WEAK', () => {
    // Suffix stripping makes "Acme Ltd" and "Acme GmbH" collide, and those are
    // different legal entities in different jurisdictions.
    const match = compareCompanyIdentity(
      identity({ name: 'Acme Ltd' }),
      identity({ name: 'Acme GmbH' }),
    );
    expect(match).toEqual({ confidence: 'weak', matchedOn: 'name' });
  });

  it('should prefer the highest-confidence signal available', () => {
    const match = compareCompanyIdentity(
      identity({ name: 'Acme', website: 'acme.com', taxId: '111' }),
      identity({ name: 'Acme', website: 'acme.com', taxId: '111' }),
    );
    expect(match?.confidence).toBe('exact');
  });

  it('should NOT let a differing tax ID veto a domain match', () => {
    // One of the two records may simply not have a tax ID recorded, and treating
    // absence as disagreement would suppress the strongest signal actually present.
    const match = compareCompanyIdentity(
      identity({ website: 'acme.com', taxId: '111' }),
      identity({ website: 'acme.com' }),
    );
    expect(match?.matchedOn).toBe('website');
  });

  it('should return null when nothing matches', () => {
    expect(
      compareCompanyIdentity(
        identity({ name: 'Acme', website: 'acme.com' }),
        identity({ name: 'Globex', website: 'globex.com' }),
      ),
    ).toBeNull();
  });

  it('should not match two records that are both empty', () => {
    // Otherwise every blank account is a duplicate of every other.
    expect(compareCompanyIdentity(identity({}), identity({}))).toBeNull();
  });
});
