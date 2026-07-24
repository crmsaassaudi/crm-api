import { ConversationRepository } from './conversation.repository';
import { createClsMock } from '../../test/mocks/cls.mock';

/**
 * C4 regression suite: conversations (which have no ownerId) must be scoped
 * by assignment (agent / group / claimer) for non-admin users, and a scoped
 * user must not read an out-of-scope conversation by id.
 */
describe('ConversationRepository — data-visibility scope (C4)', () => {
  const build = (cls: ReturnType<typeof createClsMock>) =>
    new ConversationRepository({} as any, cls as any);

  const buildFilter = (repo: ConversationRepository, query: any) =>
    (repo as any).buildFilter(query);

  const inScope = (repo: ConversationRepository, doc: any) =>
    (repo as any).isConversationInScope(doc);

  // ── list scope ────────────────────────────────────────────────────────
  it('adds NO scope clause when the user is an admin (visibleOwnerIds = null)', () => {
    const cls = createClsMock({ visibleOwnerIds: null });
    const filter = buildFilter(build(cls), { tenantId: 't1' });
    expect(filter.$and).toBeUndefined();
  });

  it('adds NO scope clause on the system path (visibleOwnerIds undefined)', () => {
    const cls = createClsMock({ visibleOwnerIds: undefined });
    const filter = buildFilter(build(cls), { tenantId: 't1' });
    expect(filter.$and).toBeUndefined();
  });

  it('restricts a scoped user to assigned-agent / claimer / group', () => {
    const cls = createClsMock({
      visibleOwnerIds: ['u1', 'u2'],
      visibleGroupIds: ['g1'],
      includeUnownedInScope: false,
    });
    const filter = buildFilter(build(cls), { tenantId: 't1' });
    const clause = filter.$and[0].$or;

    expect(clause).toEqual(
      expect.arrayContaining([
        { assignedAgentId: { $in: ['u1', 'u2'] } },
        { claimedById: { $in: ['u1', 'u2'] } },
        { assignedGroupId: { $in: ['g1'] } },
      ]),
    );
    // unassigned pool NOT included by default
    expect(clause).not.toContainEqual({
      assignedAgentId: null,
      assignedGroupId: null,
    });
  });

  it('includes the unassigned pool only when opted in', () => {
    const cls = createClsMock({
      visibleOwnerIds: ['u1'],
      visibleGroupIds: [],
      includeUnownedInScope: true,
    });
    const filter = buildFilter(build(cls), { tenantId: 't1' });
    expect(filter.$and[0].$or).toContainEqual({
      assignedAgentId: null,
      assignedGroupId: null,
    });
  });

  it('ANDs the scope on top of a caller-supplied assignment filter (cannot widen)', () => {
    const cls = createClsMock({ visibleOwnerIds: ['u1'], visibleGroupIds: [] });
    const filter = buildFilter(build(cls), {
      tenantId: 't1',
      assignedAgent: 'someone_else',
    });
    // caller filter is still applied…
    expect(filter.assignedAgentId).toBe('someone_else');
    // …AND intersected with the scope clause
    expect(filter.$and[0].$or).toContainEqual({
      assignedAgentId: { $in: ['u1'] },
    });
  });

  // ── single-record scope ────────────────────────────────────────────────
  it('allows an in-scope conversation by assigned agent', () => {
    const cls = createClsMock({ visibleOwnerIds: ['u1'], visibleGroupIds: [] });
    expect(inScope(build(cls), { assignedAgentId: 'u1' })).toBe(true);
  });

  it('allows an in-scope conversation by group', () => {
    const cls = createClsMock({
      visibleOwnerIds: ['u1'],
      visibleGroupIds: ['g9'],
    });
    expect(inScope(build(cls), { assignedGroupId: 'g9' })).toBe(true);
  });

  it('DENIES an out-of-scope conversation (assigned to a stranger)', () => {
    const cls = createClsMock({
      visibleOwnerIds: ['u1'],
      visibleGroupIds: ['g1'],
    });
    expect(inScope(build(cls), { assignedAgentId: 'stranger' })).toBe(false);
  });

  it('DENIES an unassigned conversation unless the pool is opted in', () => {
    const off = createClsMock({ visibleOwnerIds: ['u1'], visibleGroupIds: [] });
    expect(
      inScope(build(off), { assignedAgentId: null, assignedGroupId: null }),
    ).toBe(false);

    const on = createClsMock({
      visibleOwnerIds: ['u1'],
      visibleGroupIds: [],
      includeUnownedInScope: true,
    });
    expect(
      inScope(build(on), { assignedAgentId: null, assignedGroupId: null }),
    ).toBe(true);
  });

  it('allows any conversation for an admin (visibleOwnerIds null)', () => {
    const cls = createClsMock({ visibleOwnerIds: null });
    expect(inScope(build(cls), { assignedAgentId: 'anyone' })).toBe(true);
  });
});
