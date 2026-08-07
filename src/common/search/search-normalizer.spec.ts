import {
  MAX_SEARCH_KEYS,
  buildSearchKeys,
  foldSearchText,
  phoneTokens,
  queryTokens,
  searchTokens,
} from './search-normalizer';
import {
  NORMALIZER_CASES,
  TOKENIZER_DIVERGENCE_CASES,
} from './search-normalizer.fixtures';

describe('search normalizer', () => {
  describe('shared fixture table (MongoDB side)', () => {
    // The same table runs against OpenSearch's `_analyze` in
    // `search-analyzer-parity.int-spec.ts`. A change here that is not also true
    // over there is a change that will alter what a tenant can find on the day
    // they are moved between engines.
    it.each(NORMALIZER_CASES)(
      'should fold $input to $expected — $why',
      ({ input, expected }) => {
        expect(searchTokens(input)).toEqual(expected);
      },
    );
  });

  describe('declared divergences (MongoDB side)', () => {
    // The OpenSearch half of each of these runs in
    // `search-analyzer-parity.int-spec.ts`. Asserted here too so a change to
    // the JavaScript tokeniser is caught without a cluster.
    it.each(TOKENIZER_DIVERGENCE_CASES)(
      'should tokenise $input as $mongo — $why',
      ({ input, mongo }) => {
        expect(searchTokens(input)).toEqual(mongo);
      },
    );
  });

  describe('the property the whole design rests on', () => {
    it('should make every Arabic spelling of a name collide', () => {
      // If this ever fails, "switch this tenant to OpenSearch" stops being a
      // performance decision and becomes a change to what they can find.
      const spellings = ['أحمد', 'احمد', 'اَحمد', 'أحمـد'];
      const folded = new Set(spellings.map((name) => searchTokens(name)[0]));
      expect([...folded]).toEqual(['احمد']);
    });

    it('should make an accented and unaccented Vietnamese name collide', () => {
      expect(searchTokens('Nguyễn')).toEqual(searchTokens('Nguyen'));
    });

    it('should not merge words that are genuinely different', () => {
      // Folding that collapses too much is as wrong as folding too little; it
      // just fails in a direction nobody reports as a bug.
      expect(searchTokens('احمد')).not.toEqual(searchTokens('محمد'));
      expect(searchTokens('nguyen')).not.toEqual(searchTokens('nguyet'));
    });
  });

  describe('foldSearchText', () => {
    it('should be idempotent', () => {
      // The query side folds a term that may already have been folded when it
      // came off a cursor or a saved filter.
      for (const testCase of NORMALIZER_CASES) {
        const once = foldSearchText(testCase.input);
        expect(foldSearchText(once)).toBe(once);
      }
    });

    it('should not depend on the process locale', () => {
      // `toLocaleLowerCase` under a Turkish locale maps I to ı, which would
      // make the index contents depend on where the container runs.
      expect(foldSearchText('ISTANBUL')).toBe('istanbul');
    });
  });

  describe('phoneTokens', () => {
    it('should reduce a punctuated number to the digits a user dials', () => {
      expect(phoneTokens('+966 (50) 123-4567')).toEqual(['966501234567']);
    });

    it('should read Arabic-Indic digits as digits', () => {
      expect(phoneTokens('٠٥٠١٢٣٤٥٦٧')).toEqual(['0501234567']);
    });

    it('should ignore anything too short to be a phone lookup', () => {
      expect(phoneTokens('123')).toEqual([]);
      expect(phoneTokens('')).toEqual([]);
      expect(phoneTokens(null)).toEqual([]);
    });
  });

  describe('buildSearchKeys', () => {
    it('should flatten arrays, deduplicate and sort', () => {
      expect(
        buildSearchKeys(['Acme Corp', ['acme', 'billing'], null, undefined]),
      ).toEqual(['acme', 'billing', 'corp']);
    });

    it('should cap the number of keys', () => {
      // Every key is an entry in a multikey index; an uncapped array is
      // uncapped write amplification.
      const many = Array.from({ length: 500 }, (_, i) => `token${i}`);
      expect(buildSearchKeys(many)).toHaveLength(MAX_SEARCH_KEYS);
    });

    it('should produce the same array for the same content regardless of order', () => {
      expect(buildSearchKeys(['beta', 'alpha'])).toEqual(
        buildSearchKeys(['alpha', 'beta']),
      );
    });
  });

  describe('queryTokens', () => {
    it('should return nothing for a query still being typed', () => {
      // Callers must read this as "no constraint", not "match nothing" — a
      // one-character query is not a request for an empty screen.
      expect(queryTokens('a')).toEqual([]);
    });

    it('should bound how many terms one query can AND together', () => {
      const long = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
      expect(queryTokens(long).length).toBeLessThanOrEqual(8);
    });
  });
});
