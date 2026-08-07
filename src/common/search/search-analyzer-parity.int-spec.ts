import axios from 'axios';
import {
  NORMALIZER_CASES,
  TOKENIZER_DIVERGENCE_CASES,
} from './search-normalizer.fixtures';
import { searchTokens } from './search-normalizer';

/**
 * The two engines are held to one definition of "the same word".
 *
 * Which engine serves a tenant is a per-tenant setting: small tenants stay on
 * MongoDB, VIP and high-volume tenants move to OpenSearch. That makes string
 * normalisation the one thing the two are not allowed to disagree about. A
 * tenant switched over must not discover that `احمد` has stopped finding
 * `أحمد`, or that a phone number typed on an Arabic keyboard no longer matches.
 *
 * The MongoDB side is `searchTokens()`, a pure function. The OpenSearch side is
 * asked of a **real cluster, through the index the indexer actually built** —
 * not of a copy of the mapping kept in this repo. Two reasons:
 *
 *   - Asserting against a local copy would only prove two files agree, not that
 *     Lucene does what the files claim.
 *   - The mapping lives in a different repository. Any copy of it here would be
 *     a second definition joined to the first by a comment, which is precisely
 *     the failure mode this suite exists to prevent.
 *
 *   cd crm-opensearch && npm run test:it:up && npm run test:it
 *   cd crm-api && npm run test:search:it
 *
 * Verified red-able: drop `arabic_normalization` from the analyzer chain in
 * `crm-opensearch/src/index/index-definition.ts`, rebuild the index, and every
 * Arabic case here fails.
 */
const NODE = process.env.IT_OPENSEARCH_NODE ?? 'http://127.0.0.1:9251';
const ALIAS = 'it-global-search';

jest.setTimeout(120_000);

const os = axios.create({ baseURL: NODE, timeout: 20_000 });

/** Tokens the live index produces for `text` under the shared analyzer. */
async function analyze(text: string): Promise<string[]> {
  const response = await os.post(`/${ALIAS}/_analyze`, {
    analyzer: 'crm_search',
    text,
  });
  return (response.data?.tokens ?? []).map(
    (token: { token: string }) => token.token,
  );
}

describe('search normalisation parity: MongoDB vs OpenSearch', () => {
  it('should be running against an index that has the shared filter chain', async () => {
    // A cluster still serving an index built before the Arabic filters were
    // added would fail every case below with an unhelpful diff. Say so once,
    // clearly, instead.
    const settings = await os.get(`/${ALIAS}/_settings`);
    const [index] = Object.values(settings.data) as any[];
    const filters =
      index?.settings?.index?.analysis?.analyzer?.crm_search?.filter ?? [];
    expect(filters).toEqual(
      expect.arrayContaining([
        'lowercase',
        'decimal_digit',
        'arabic_normalization',
        'asciifolding',
      ]),
    );
  });

  it.each(NORMALIZER_CASES)(
    'should agree on $input → $expected — $why',
    async ({ input, expected }) => {
      const fromOpenSearch = await analyze(input);
      const fromMongo = searchTokens(input);

      // MongoDB drops single-character tokens: a one-character prefix match is
      // not a search, it is the user still typing. OpenSearch's standard
      // tokenizer keeps them. That is a difference in what gets *indexed*, not
      // in how a word is *folded*, so the comparison is made over the tokens
      // both sides would actually use.
      const comparable = fromOpenSearch.filter((token) => token.length >= 2);

      expect(comparable).toEqual(expected);
      expect(fromMongo).toEqual(expected);
    },
  );

  describe('declared divergences in word breaking', () => {
    // Folding is shared; UAX#29 word breaking is not. Both sides are asserted
    // so the gap cannot quietly widen — if either tokenizer changes, this goes
    // red and somebody decides on purpose.
    it.each(TOKENIZER_DIVERGENCE_CASES)(
      'should diverge only as declared on $input — $why',
      async ({ input, mongo, openSearch }) => {
        expect(searchTokens(input)).toEqual(mongo);
        expect(await analyze(input)).toEqual(openSearch);
      },
    );
  });

  it('should fold every Arabic spelling of a name to one token on both sides', async () => {
    const spellings = ['أحمد', 'احمد', 'اَحمد', 'أحمـد'];
    const viaOpenSearch = new Set<string>();
    for (const spelling of spellings) {
      viaOpenSearch.add((await analyze(spelling)).join(' '));
    }
    const viaMongo = new Set(
      spellings.map((spelling) => searchTokens(spelling).join(' ')),
    );

    expect([...viaOpenSearch]).toEqual(['احمد']);
    expect([...viaMongo]).toEqual(['احمد']);
  });
});
