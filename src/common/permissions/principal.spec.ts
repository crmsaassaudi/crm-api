import { PrincipalType, resolvePrincipalType } from './principal';

describe('resolvePrincipalType', () => {
  it('defaults to USER when no marker is present', () => {
    expect(resolvePrincipalType({})).toBe(PrincipalType.USER);
    expect(resolvePrincipalType(undefined)).toBe(PrincipalType.USER);
    expect(resolvePrincipalType({ sub: 'abc', email: 'a@b.c' })).toBe(
      PrincipalType.USER,
    );
  });

  it('honors an explicit, known principal_type claim', () => {
    expect(resolvePrincipalType({ principal_type: 'agent' })).toBe(
      PrincipalType.AGENT,
    );
    expect(resolvePrincipalType({ principal_type: 'service' })).toBe(
      PrincipalType.SERVICE,
    );
  });

  it('fails safe to USER for an unknown/garbage principal_type', () => {
    expect(resolvePrincipalType({ principal_type: 'root' })).toBe(
      PrincipalType.USER,
    );
    expect(resolvePrincipalType({ principal_type: 123 as any })).toBe(
      PrincipalType.USER,
    );
  });

  it('detects a Keycloak service-account token as SERVICE', () => {
    expect(
      resolvePrincipalType({ preferred_username: 'service-account-integration' }),
    ).toBe(PrincipalType.SERVICE);
  });

  it('an explicit agent claim wins over the service-account username shape', () => {
    expect(
      resolvePrincipalType({
        principal_type: 'agent',
        preferred_username: 'service-account-bot',
      }),
    ).toBe(PrincipalType.AGENT);
  });
});
