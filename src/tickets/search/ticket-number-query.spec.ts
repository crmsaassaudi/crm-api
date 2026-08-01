import { normalizeTicketNumberQuery } from './ticket-number-query';

describe('normalizeTicketNumberQuery', () => {
  it('should recognise the generated form in any case, with padding preserved', () => {
    expect(normalizeTicketNumberQuery('TKT-00042')).toBe('TKT-00042');
    expect(normalizeTicketNumberQuery('tkt-00042')).toBe('TKT-00042');
    expect(normalizeTicketNumberQuery('  TKT-00042  ')).toBe('TKT-00042');
  });

  it('should accept the "#" a human puts in front of a reference', () => {
    expect(normalizeTicketNumberQuery('#TKT-00042')).toBe('TKT-00042');
  });

  it('should pad a bare counter to the width the generator uses', () => {
    expect(normalizeTicketNumberQuery('42')).toBe('TKT-00042');
    expect(normalizeTicketNumberQuery('00042')).toBe('TKT-00042');
  });

  it('should recognise the ULID form the import worker mints', () => {
    expect(normalizeTicketNumberQuery('TKT-01H2XVQZ')).toBe('TKT-01H2XVQZ');
  });

  it('should refuse free text so it keeps going to text search', () => {
    // Returning a ticket number here would answer "payment failed" with an
    // exact match that finds nothing — worse than a slow but correct search.
    expect(normalizeTicketNumberQuery('payment failed')).toBeNull();
    expect(normalizeTicketNumberQuery('refund')).toBeNull();
    expect(normalizeTicketNumberQuery('TKT')).toBeNull();
    expect(normalizeTicketNumberQuery('TKT-')).toBeNull();
    expect(normalizeTicketNumberQuery('TKT-00042 refund')).toBeNull();
    expect(normalizeTicketNumberQuery('')).toBeNull();
  });

  it('should refuse a long digit run, which is a phone or order reference', () => {
    expect(normalizeTicketNumberQuery('0912345678')).toBeNull();
  });
});
