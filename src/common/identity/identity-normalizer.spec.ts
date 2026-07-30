import {
  normalizeEmail,
  normalizeEmails,
  normalizePhone,
  normalizePhones,
  splitMultiValue,
} from './identity-normalizer';

describe('normalizeEmail', () => {
  it('should lower-case and trim', () => {
    expect(normalizeEmail('  John@Acme.COM ')).toBe('john@acme.com');
  });

  it('should not fold gmail dots or +tags (lossless by design)', () => {
    expect(normalizeEmail('a.b+news@gmail.com')).toBe('a.b+news@gmail.com');
  });
});

describe('normalizePhone', () => {
  it('should preserves a leading + and strips separators', () => {
    expect(normalizePhone('+84 90 111 2222')).toBe('+84901112222');
  });

  it('should treats 00 as the international prefix', () => {
    expect(normalizePhone('0084901112222')).toBe('+84901112222');
  });

  it('should promotes national format to E.164 with a country code', () => {
    expect(normalizePhone('0901112222', '84')).toBe('+84901112222');
  });

  it('should makes UI-entered and imported forms comparable', () => {
    expect(normalizePhone('0901112222', '84')).toBe(
      normalizePhone('+84 901 112 222', '84'),
    );
  });

  it('should adds + when the number already carries the country code', () => {
    expect(normalizePhone('84901112222', '84')).toBe('+84901112222');
  });

  it('should leaves digits alone when no country code is configured', () => {
    expect(normalizePhone('0901112222')).toBe('0901112222');
  });

  it('should returns empty for a value with no digits', () => {
    expect(normalizePhone('n/a')).toBe('');
  });
});

describe('normalizeEmails / normalizePhones', () => {
  it('should de-duplicates after normalising', () => {
    expect(normalizeEmails(['A@b.com', 'a@B.com'])).toEqual(['a@b.com']);
  });

  it('should drops empties', () => {
    expect(normalizePhones(['', '  ', '+1 415 555 1234'])).toEqual([
      '+14155551234',
    ]);
  });

  it('should accepts a bare string', () => {
    expect(normalizeEmails('X@Y.com')).toEqual(['x@y.com']);
  });

  it('should ignores non-string entries', () => {
    expect(normalizeEmails([1, 'a@b.com', null])).toEqual(['a@b.com']);
  });
});

describe('splitMultiValue', () => {
  it('should splits on comma and semicolon', () => {
    expect(splitMultiValue('a@x.com; b@y.com,c@z.com')).toEqual([
      'a@x.com',
      'b@y.com',
      'c@z.com',
    ]);
  });
});
