import openSearchConfig from './opensearch.config';

/**
 * The registry's narrowing rule is only worth anything if the process actually
 * refuses to start on a bad override. Unit-testing `parseCapabilityOverrides`
 * proves the parser; this proves the parser is on the boot path.
 */
describe('opensearch config', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  const load = () => (openSearchConfig as unknown as () => unknown)();

  it('should default to no capability overrides', () => {
    delete process.env.SEARCH_CAPABILITY_OVERRIDES;
    process.env.OPENSEARCH_ENABLED = 'false';
    expect(load()).toMatchObject({ capabilityOverrides: {} });
  });

  it('should parse narrowing overrides', () => {
    process.env.OPENSEARCH_ENABLED = 'false';
    process.env.SEARCH_CAPABILITY_OVERRIDES = 'global_search:mongodb';
    expect(load()).toMatchObject({
      capabilityOverrides: { global_search: 'mongodb' },
    });
  });

  it('should refuse to boot when an override would widen towards OpenSearch', () => {
    // A configuration line must never be able to hand a question to an engine
    // the registry did not sanction — nor to undo the kill switch.
    process.env.OPENSEARCH_ENABLED = 'false';
    process.env.SEARCH_CAPABILITY_OVERRIDES = 'export:opensearch';
    expect(load).toThrow(/may only narrow/);
  });

  it('should refuse to boot on a misspelled capability rather than ignore it', () => {
    process.env.OPENSEARCH_ENABLED = 'false';
    process.env.SEARCH_CAPABILITY_OVERRIDES = 'gloabl_search:off';
    expect(load).toThrow(/unknown capability/);
  });
});
