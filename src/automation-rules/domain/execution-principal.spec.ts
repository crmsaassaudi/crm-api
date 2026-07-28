import { DEFAULT_RUN_AS, resolvePrincipal } from './execution-principal';

/**
 * Automation used to execute with no principal at all: the payload and job data
 * carried only `tenantId`, so every authorization layer — all of which read CLS
 * populated by an HTTP interceptor — was inert, and a workflow acted with full
 * tenant scope no matter who built it.
 */
describe('resolvePrincipal', () => {
  const base = {
    workflowId: 'wf1',
    workflowCreatedBy: 'author-1',
    triggerUserId: 'actor-1',
    recordOwnerId: 'owner-1',
  };

  it('should default to the system principal for a workflow with no runAs', () => {
    // Preserves the behaviour of every workflow authored before runAs existed.
    expect(DEFAULT_RUN_AS).toBe('system');

    const principal = resolvePrincipal({ ...base, runAs: undefined });

    expect(principal).toMatchObject({ kind: 'system', userId: null });
  });

  it('should bind to the workflow author for runAs=creator', () => {
    const principal = resolvePrincipal({ ...base, runAs: 'creator' });

    expect(principal).toMatchObject({
      kind: 'user',
      userId: 'author-1',
      runAs: 'creator',
      grantedByWorkflowId: 'wf1',
    });
  });

  it('should bind to the acting user for runAs=trigger_user', () => {
    const principal = resolvePrincipal({ ...base, runAs: 'trigger_user' });

    expect(principal).toMatchObject({ kind: 'user', userId: 'actor-1' });
  });

  it('should bind to the record owner for runAs=record_owner', () => {
    const principal = resolvePrincipal({ ...base, runAs: 'record_owner' });

    expect(principal).toMatchObject({ kind: 'user', userId: 'owner-1' });
  });

  it.each([
    ['creator', { workflowCreatedBy: null }, /no usable createdBy/],
    ['trigger_user', { triggerUserId: null }, /no acting user/],
    ['record_owner', { recordOwnerId: null }, /unowned/],
  ])('should fail closed when %s has no user', (runAs, missing, reason) => {
    expect(() =>
      resolvePrincipal({
        ...base,
        ...missing,
        runAs: runAs as any,
      }),
    ).toThrow(reason);
  });

  it('should not mistake the legacy "system" placeholder for a user id', () => {
    // `'system'` is what createdBy held before actor tracking was fixed (H4).
    expect(() =>
      resolvePrincipal({
        ...base,
        runAs: 'creator',
        workflowCreatedBy: 'system',
      }),
    ).toThrow(/no usable createdBy/);
  });
});
