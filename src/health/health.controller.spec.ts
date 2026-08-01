import { HealthController } from './health.controller';

/**
 * The capability table on `/health/deep` exists so that "why is this tenant not
 * finding anything" is answerable with one request. That only holds if it
 * reports what the router will actually do — so these assert the two agree,
 * rather than that the endpoint returns some shape.
 */
describe('HealthController search capabilities', () => {
  const controller = (
    openSearchConfig: Record<string, unknown> | undefined,
  ): HealthController =>
    new HealthController(
      undefined,
      undefined,
      undefined,
      openSearchConfig ? ({ get: () => openSearchConfig } as never) : undefined,
      undefined,
      undefined,
    );

  const capabilities = async (config: Record<string, unknown> | undefined) => {
    const report = await controller(config).deep();
    return report.searchCapabilities as Record<
      string,
      { tier: string; owner: string; servedBy: string; reason?: string }
    >;
  };

  it('should report MongoDB for every capability when OpenSearch is off', async () => {
    const report = await capabilities({
      enabled: false,
      capabilityOverrides: {},
    });
    expect(report.global_search).toMatchObject({
      tier: 'R',
      owner: 'opensearch',
      servedBy: 'mongodb',
      divertedByConfig: true,
      reason: 'opensearch_disabled',
    });
    expect(report.export).toMatchObject({ tier: 'E', servedBy: 'mongodb' });
  });

  it('should report OpenSearch only for the capabilities that own it', async () => {
    const report = await capabilities({
      enabled: true,
      capabilityOverrides: {},
    });
    expect(report.global_search.servedBy).toBe('opensearch');
    // Tier E stays on MongoDB even with a healthy cluster: the engine follows
    // from the nature of the question, not from what happens to be reachable.
    expect(report.contact_list.servedBy).toBe('mongodb');
    expect(report.export.servedBy).toBe('mongodb');
  });

  it('should show an operator override and the reason for it', async () => {
    const report = await capabilities({
      enabled: true,
      capabilityOverrides: { global_search: 'off' },
    });
    expect(report.global_search).toMatchObject({
      servedBy: 'disabled',
      reason: 'disabled_by_config',
    });
  });

  it('should not fail when no configuration is wired at all', async () => {
    // The probe is `@Public()` and every dependency is `@Optional()`; a missing
    // config must not turn the operator's diagnostic endpoint into a 500 during
    // the incident it exists for.
    const report = await capabilities(undefined);
    expect(report.global_search.servedBy).toBe('mongodb');
  });
});
