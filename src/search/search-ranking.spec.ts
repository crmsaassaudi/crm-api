import { rankSearchResult } from './search-ranking';

describe('rankSearchResult', () => {
  it('should rank exact and prefix title matches above subtitle matches', () => {
    expect(rankSearchResult('acme', 'Acme').score).toBe(1);
    expect(rankSearchResult('acme', 'Acme Holdings').score).toBe(0.9);
    expect(
      rankSearchResult('acme', 'Renewal', 'Acme Holdings').score,
    ).toBeLessThan(0.9);
  });

  it('should return structured highlight ranges without injecting markup', () => {
    expect(rankSearchResult('acme', '<b>Acme</b>').highlights.title).toEqual([
      { start: 3, end: 7 },
    ]);
  });
});
