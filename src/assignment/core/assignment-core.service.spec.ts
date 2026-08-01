/* eslint-disable @typescript-eslint/require-await -- mock factories model async
   collaborators; an await inside them would be noise. */
import {
  AssignmentCoreService,
  AssignRequest,
} from './assignment-core.service';
import { AssignmentAdapter, AssignmentScope } from './ports';
import { mergeAssignmentConfig } from './assignment-config.service';
import { AssignmentStrategy } from '../domain/assignment.types';

/**
 * A LoadPort that models the real invariant: `reserve` increments, `release`
 * decrements, and a candidate at or above capacity cannot be reserved.
 *
 * Tests then assert on the counters afterwards, which is the only way to catch a
 * leaked reservation — the failure mode that made the old record engine
 * mis-distribute work silently.
 */
class FakeLoad {
  readonly loadsByAgent = new Map<string, number>();
  capacity = 2;
  reserveCalls = 0;
  releaseCalls: string[] = [];
  rotated: string[] | null = null;
  /** Force every reserve to fail, to exercise the at-capacity path. */
  refuseAll = false;

  constructor(seed: Record<string, number> = {}) {
    for (const [id, load] of Object.entries(seed))
      this.loadsByAgent.set(id, load);
  }

  async loads(
    _scope: AssignmentScope,
    ids: string[],
  ): Promise<Map<string, number>> {
    return new Map(ids.map((id) => [id, this.loadsByAgent.get(id) ?? 0]));
  }

  async rotate(_scope: AssignmentScope, ids: string[]): Promise<string[]> {
    this.rotated = ids;
    return ids;
  }

  /** Shared by reserve and preview, so the two cannot disagree. */
  private choose(
    ordered: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): string | null {
    const cap = Math.min(maxCapacity, this.capacity);
    const pool =
      strategy === 'round-robin'
        ? ordered
        : [...ordered].sort(
            (a, b) =>
              (this.loadsByAgent.get(a) ?? 0) - (this.loadsByAgent.get(b) ?? 0),
          );
    return pool.find((id) => (this.loadsByAgent.get(id) ?? 0) < cap) ?? null;
  }

  async reserve(
    _scope: AssignmentScope,
    ordered: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null> {
    this.reserveCalls++;
    if (this.refuseAll) return null;
    const pick = this.choose(ordered, strategy, maxCapacity);
    if (!pick) return null;
    this.loadsByAgent.set(pick, (this.loadsByAgent.get(pick) ?? 0) + 1);
    return pick;
  }

  async preview(
    _scope: AssignmentScope,
    ordered: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null> {
    return this.choose(ordered, strategy, maxCapacity);
  }

  async release(_scope: AssignmentScope, id: string): Promise<void> {
    this.releaseCalls.push(id);
    this.loadsByAgent.set(
      id,
      Math.max(0, (this.loadsByAgent.get(id) ?? 0) - 1),
    );
  }
}

class FakeCandidates {
  pool: string[] | undefined;
  members = new Map<string, string[]>();
  skillsByAgent = new Map<string, string[]>();
  disallowedGroups = new Set<string>();
  requireOnlineSeen: boolean | null = null;
  offline = new Set<string>();

  constructor(pool?: string[]) {
    this.pool = pool;
  }

  async basePool(): Promise<string[] | undefined> {
    return this.pool;
  }

  async groupMembers(
    _scope: AssignmentScope,
    groupIds: string[],
  ): Promise<string[]> {
    return groupIds.flatMap((id) => this.members.get(id) ?? []);
  }

  async groupMayServe(
    _scope: AssignmentScope,
    groupId: string,
  ): Promise<boolean> {
    return !this.disallowedGroups.has(groupId);
  }

  async skills(
    _scope: AssignmentScope,
    ids: string[],
  ): Promise<Map<string, string[]>> {
    return new Map(ids.map((id) => [id, this.skillsByAgent.get(id) ?? []]));
  }

  async filterAvailable(
    _scope: AssignmentScope,
    ids: string[],
    requireOnline: boolean,
  ): Promise<string[]> {
    this.requireOnlineSeen = requireOnline;
    if (!requireOnline) return ids;
    return ids.filter((id) => !this.offline.has(id));
  }
}

class FakeCommit {
  committed: Array<{ assigneeId: string; groupId: string | null }> = [];
  parked: string[] = [];
  /** null = succeed, 'race' = return false, 'throw' = throw */
  mode: 'ok' | 'race' | 'throw' = 'ok';

  async commit(
    _scope: AssignmentScope,
    assigneeId: string,
    groupId: string | null,
  ): Promise<boolean> {
    if (this.mode === 'throw') throw new Error('write failed');
    if (this.mode === 'race') return false;
    this.committed.push({ assigneeId, groupId });
    return true;
  }

  async park(_scope: AssignmentScope, groupId: string): Promise<void> {
    this.parked.push(groupId);
  }
}

function buildHarness(options?: {
  pool?: string[];
  settings?: Record<string, unknown>;
  rules?: Array<{
    ruleId: string;
    ruleName: string;
    userId?: string | null;
    groupIds?: string[];
    strategy?: AssignmentStrategy | null;
    requiredSkills?: string[];
  }>;
  seedLoads?: Record<string, number>;
}) {
  const candidates = new FakeCandidates(options?.pool);
  const load = new FakeLoad(options?.seedLoads);
  const commit = new FakeCommit();

  const adapter: AssignmentAdapter = {
    objectTypes: ['Ticket'],
    candidates: candidates as any,
    load: load as any,
    commit: commit as any,
  };

  const stored = options?.settings ?? { autoAssignEnabled: true };
  const config = {
    resolve: jest.fn(async (_t: string, _o: string, override?: any) =>
      mergeAssignmentConfig(stored as any, override),
    ),
  };

  const matched = options?.rules?.[0] ?? null;
  const ruleEvaluator = {
    evaluate: jest.fn(async () => ({
      match: matched
        ? {
            ruleId: matched.ruleId,
            ruleName: matched.ruleName,
            userId: matched.userId ?? null,
            groupIds: matched.groupIds ?? [],
            strategy: matched.strategy ?? null,
            requiredSkills: matched.requiredSkills ?? [],
          }
        : null,
      traces: [],
    })),
  };

  const audit = { write: jest.fn(async () => undefined) };

  const core = new AssignmentCoreService(
    config as any,
    ruleEvaluator as any,
    audit as any,
    [adapter],
  );

  return { core, candidates, load, commit, audit, config, ruleEvaluator };
}

const base: AssignRequest = {
  tenantId: 't1',
  objectType: 'Ticket',
  entityId: 'e1',
};

describe('AssignmentCoreService', () => {
  describe('gates', () => {
    it('should skip when the caller bypasses', async () => {
      const { core, load } = buildHarness({ pool: ['a'] });
      const decision = await core.assign({ ...base, bypass: true });
      expect(decision.outcome).toBe('skipped');
      expect(decision.reasonKey).toBe('bypassed');
      expect(load.reserveCalls).toBe(0);
    });

    it('should skip when auto-assign is off for the objectType', async () => {
      const { core, load } = buildHarness({
        pool: ['a'],
        settings: { autoAssignEnabled: false },
      });
      const decision = await core.assign(base);
      expect(decision.outcome).toBe('skipped');
      expect(decision.reasonKey).toBe('autoAssignDisabled');
      expect(load.reserveCalls).toBe(0);
    });

    it('should honour a manual override even when auto-assign is off', async () => {
      const { core, commit } = buildHarness({
        pool: ['a'],
        settings: { autoAssignEnabled: false },
      });
      const decision = await core.assign({ ...base, manualAssigneeId: 'z' });
      expect(decision.outcome).toBe('assigned');
      expect(decision.assigneeId).toBe('z');
      expect(commit.committed).toEqual([{ assigneeId: 'z', groupId: null }]);
    });

    it('should report failed, not queued, when no adapter is registered', async () => {
      const { core } = buildHarness({ pool: ['a'] });
      const decision = await core.assign({ ...base, objectType: 'Deal' });
      expect(decision.outcome).toBe('failed');
    });
  });

  describe('target resolution', () => {
    it('should assign from the base pool when no rule matches', async () => {
      const { core, commit } = buildHarness({ pool: ['a', 'b'] });
      const decision = await core.assign(base);
      expect(decision.outcome).toBe('assigned');
      expect(['a', 'b']).toContain(decision.assigneeId);
      expect(commit.committed).toHaveLength(1);
    });

    it('should treat an empty base pool as nobody, never as unrestricted', async () => {
      const { core, load } = buildHarness({ pool: [] });
      const decision = await core.assign(base);
      expect(decision.outcome).toBe('queued');
      expect(decision.reasonKey).toBe('emptyPool');
      expect(load.reserveCalls).toBe(0);
    });

    it('should intersect the rule team with the base pool and never widens back', async () => {
      const h = buildHarness({
        pool: ['a'],
        rules: [{ ruleId: 'r1', ruleName: 'VIP', groupIds: ['g1'] }],
      });
      // g1 contains only 'b', who is not in the base pool.
      h.candidates.members.set('g1', ['b']);
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
      // Filed under the rule's team so it lands in that team's queue.
      expect(decision.groupId).toBe('g1');
      expect(h.commit.parked).toEqual(['g1']);
      // Crucially: it did not fall back to assigning 'a'.
      expect(h.commit.committed).toHaveLength(0);
    });

    it('should walk the escalation chain to the first team with someone free', async () => {
      const h = buildHarness({
        pool: ['a', 'b'],
        rules: [{ ruleId: 'r1', ruleName: 'Tiered', groupIds: ['g1', 'g2'] }],
      });
      h.candidates.members.set('g1', ['nobody']);
      h.candidates.members.set('g2', ['b']);
      const decision = await h.core.assign(base);
      expect(decision.assigneeId).toBe('b');
      expect(decision.groupId).toBe('g2');
    });

    it('should skip a chain tier the scope does not authorise instead of failing the rule', async () => {
      const h = buildHarness({
        pool: ['a', 'b'],
        rules: [{ ruleId: 'r1', ruleName: 'Tiered', groupIds: ['g1', 'g2'] }],
      });
      h.candidates.disallowedGroups.add('g1');
      h.candidates.members.set('g1', ['a']);
      h.candidates.members.set('g2', ['b']);
      const decision = await h.core.assign(base);
      expect(decision.assigneeId).toBe('b');
      expect(decision.groupId).toBe('g2');
    });

    it('should queue as unroutable when no team in the chain may serve the scope', async () => {
      const h = buildHarness({
        pool: ['a'],
        rules: [{ ruleId: 'r1', ruleName: 'Wrong', groupIds: ['g1'] }],
      });
      h.candidates.disallowedGroups.add('g1');
      h.candidates.members.set('g1', ['a']);
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
      expect(decision.reasonKey).toBe('groupNotEligible');
      expect(decision.groupId).toBeNull();
    });

    it('should subject a pinned user to the base pool', async () => {
      const h = buildHarness({
        pool: ['a'],
        rules: [{ ruleId: 'r1', ruleName: 'Pin', userId: 'outsider' }],
      });
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
      expect(h.commit.committed).toHaveLength(0);
    });

    it('should apply restrictToCandidates on top of the base pool', async () => {
      const h = buildHarness({ pool: ['a', 'b', 'c'] });
      const decision = await h.core.assign({
        ...base,
        restrictToCandidates: ['b'],
      });
      expect(decision.assigneeId).toBe('b');
    });

    it('should queue when restrictToCandidates is empty', async () => {
      const h = buildHarness({ pool: ['a', 'b'] });
      const decision = await h.core.assign({
        ...base,
        restrictToCandidates: [],
      });
      expect(decision.outcome).toBe('queued');
    });

    it('should skip excluded candidates', async () => {
      const h = buildHarness({ pool: ['a', 'b'] });
      const decision = await h.core.assign({
        ...base,
        excludeCandidates: ['a'],
      });
      expect(decision.assigneeId).toBe('b');
    });

    it('should queue when the exclusion empties the pool', async () => {
      const h = buildHarness({ pool: ['a'] });
      const decision = await h.core.assign({
        ...base,
        excludeCandidates: ['a'],
      });
      expect(decision.outcome).toBe('queued');
      expect(h.commit.committed).toHaveLength(0);
    });

    it('should treat an empty exclusion list as no exclusion', async () => {
      const h = buildHarness({ pool: ['a'] });
      const decision = await h.core.assign({ ...base, excludeCandidates: [] });
      expect(decision.assigneeId).toBe('a');
    });
  });

  describe('skills', () => {
    it('should keep only candidates holding every required skill', async () => {
      const h = buildHarness({
        pool: ['a', 'b'],
        settings: { autoAssignEnabled: true, skillBasedRoutingEnabled: true },
        rules: [
          {
            ruleId: 'r1',
            ruleName: 'English',
            groupIds: ['g1'],
            requiredSkills: ['english'],
          },
        ],
      });
      h.candidates.members.set('g1', ['a', 'b']);
      h.candidates.skillsByAgent.set('a', ['vietnamese']);
      h.candidates.skillsByAgent.set('b', ['english', 'vietnamese']);
      const decision = await h.core.assign(base);
      expect(decision.assigneeId).toBe('b');
    });

    it('should fall back to the whole pool when nobody holds the skill', async () => {
      const h = buildHarness({
        pool: ['a'],
        settings: { autoAssignEnabled: true, skillBasedRoutingEnabled: true },
        rules: [
          {
            ruleId: 'r1',
            ruleName: 'English',
            groupIds: ['g1'],
            requiredSkills: ['klingon'],
          },
        ],
      });
      h.candidates.members.set('g1', ['a']);
      const decision = await h.core.assign(base);
      expect(decision.assigneeId).toBe('a');
    });

    it('should queue instead of falling back when skillFallbackMode is strict', async () => {
      const h = buildHarness({
        pool: ['a'],
        settings: {
          autoAssignEnabled: true,
          skillBasedRoutingEnabled: true,
          skillFallbackMode: 'strict',
        },
        rules: [
          {
            ruleId: 'r1',
            ruleName: 'English',
            groupIds: ['g1'],
            requiredSkills: ['klingon'],
          },
        ],
      });
      h.candidates.members.set('g1', ['a']);
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
      expect(decision.assigneeId).toBeNull();
    });

    it('should ignore required skills when skill routing is off', async () => {
      const h = buildHarness({
        pool: ['a'],
        rules: [
          {
            ruleId: 'r1',
            ruleName: 'English',
            groupIds: ['g1'],
            requiredSkills: ['english'],
          },
        ],
      });
      h.candidates.members.set('g1', ['a']);
      const decision = await h.core.assign(base);
      expect(decision.assigneeId).toBe('a');
    });
  });

  describe('availability', () => {
    it('should pass requireOnline through to the adapter and queues when all are offline', async () => {
      const h = buildHarness({
        pool: ['a'],
        settings: { autoAssignEnabled: true, requireOnline: true },
      });
      h.candidates.offline.add('a');
      const decision = await h.core.assign(base);
      expect(h.candidates.requireOnlineSeen).toBe(true);
      expect(decision.outcome).toBe('queued');
      expect(h.load.reserveCalls).toBe(0);
    });
  });

  describe('reservation invariants', () => {
    it('should leave the load counter incremented exactly once on success', async () => {
      const h = buildHarness({ pool: ['a'] });
      await h.core.assign(base);
      expect(h.load.loadsByAgent.get('a')).toBe(1);
      expect(h.load.releaseCalls).toEqual([]);
    });

    // This is the class of bug that made `compensate()` necessary and then went
    // unfixed because no caller ever invoked it.
    it('should release the reservation when the commit loses a race', async () => {
      const h = buildHarness({ pool: ['a'] });
      h.commit.mode = 'race';
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
      expect(decision.reasonKey).toBe('commitRaceLost');
      expect(h.load.releaseCalls).toEqual(['a']);
      expect(h.load.loadsByAgent.get('a')).toBe(0);
    });

    it('should release the reservation and rethrows when the commit throws', async () => {
      const h = buildHarness({ pool: ['a'] });
      h.commit.mode = 'throw';
      await expect(h.core.assign(base)).rejects.toThrow('write failed');
      expect(h.load.releaseCalls).toEqual(['a']);
      expect(h.load.loadsByAgent.get('a')).toBe(0);
    });

    it('should reserve nothing when every candidate is at capacity', async () => {
      const h = buildHarness({ pool: ['a'], seedLoads: { a: 5 } });
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
      expect(decision.reasonKey).toBe('allAtCapacity');
      expect(h.load.releaseCalls).toEqual([]);
    });

    it('should use a caller-supplied commit and still owns the reservation', async () => {
      const h = buildHarness({ pool: ['a'] });
      const commit = jest.fn(async () => false);
      const decision = await h.core.assign({ ...base, commit });
      expect(commit).toHaveBeenCalledWith('a', null);
      expect(decision.reasonKey).toBe('commitRaceLost');
      expect(h.load.releaseCalls).toEqual(['a']);
    });
  });

  describe('fallback owner', () => {
    it('should assign the fallback owner when nobody could be reserved', async () => {
      const h = buildHarness({
        pool: ['a'],
        seedLoads: { a: 5 },
        settings: { autoAssignEnabled: true, fallbackOwnerId: 'boss' },
      });
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('assigned');
      expect(decision.assigneeId).toBe('boss');
      expect(decision.reasonKey).toBe('fallbackOwner');
    });

    it('should queue when the fallback owner is not configured', async () => {
      const h = buildHarness({ pool: ['a'], seedLoads: { a: 5 } });
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
    });
  });

  describe('preferred assignee', () => {
    const preferSettings = {
      autoAssignEnabled: true,
      preferPreviousAssignee: true,
    };

    it('should assign the preferred candidate when they are eligible', async () => {
      const h = buildHarness({ pool: ['a', 'b'], settings: preferSettings });
      const decision = await h.core.assign({
        ...base,
        preferred: { assigneeId: 'b', onBusy: 'fall-through' },
      });
      expect(decision.assigneeId).toBe('b');
      expect(decision.reasonKey).toBe('preferredAssignee');
    });

    it('should fall through to the strategy when the preferred candidate is busy', async () => {
      const h = buildHarness({
        pool: ['a', 'b'],
        settings: preferSettings,
        seedLoads: { b: 5 },
      });
      const decision = await h.core.assign({
        ...base,
        preferred: { assigneeId: 'b', onBusy: 'fall-through' },
      });
      expect(decision.assigneeId).toBe('a');
    });

    it('should defer when the preferred candidate is busy and a wait is configured', async () => {
      const h = buildHarness({
        pool: ['a', 'b'],
        settings: { ...preferSettings, previousAssigneeWaitMinutes: 3 },
        seedLoads: { b: 5 },
      });
      const decision = await h.core.assign({
        ...base,
        preferred: { assigneeId: 'b', onBusy: 'wait' },
      });
      expect(decision.outcome).toBe('deferred');
      expect(decision.deferred).toEqual({ assigneeId: 'b', waitMinutes: 3 });
      // Nothing was assigned and nothing leaked.
      expect(h.commit.committed).toHaveLength(0);
      expect(h.load.loadsByAgent.get('a') ?? 0).toBe(0);
    });

    it('should ignore the preference when the candidate is outside the pool', async () => {
      const h = buildHarness({ pool: ['a'], settings: preferSettings });
      const decision = await h.core.assign({
        ...base,
        preferred: { assigneeId: 'stranger', onBusy: 'fall-through' },
      });
      expect(decision.assigneeId).toBe('a');
    });

    it('should ignore the preference when the setting is off', async () => {
      const h = buildHarness({ pool: ['a', 'b'] });
      const decision = await h.core.assign({
        ...base,
        preferred: { assigneeId: 'b', onBusy: 'fall-through' },
      });
      expect(decision.reasonKey).toBe('assigned');
    });
  });

  describe('strategies', () => {
    it('should rotate for round-robin', async () => {
      const h = buildHarness({ pool: ['a', 'b'] });
      await h.core.assign(base);
      expect(h.load.rotated).toEqual(['a', 'b']);
    });

    it('should not rotate for least-busy, and picks the lowest load', async () => {
      const h = buildHarness({
        pool: ['a', 'b'],
        settings: { autoAssignEnabled: true, defaultStrategy: 'least-busy' },
        seedLoads: { a: 1, b: 0 },
      });
      const decision = await h.core.assign(base);
      expect(h.load.rotated).toBeNull();
      expect(decision.assigneeId).toBe('b');
    });

    it('should queue under the team for the manual strategy without reserving', async () => {
      const h = buildHarness({
        pool: ['a'],
        rules: [
          {
            ruleId: 'r1',
            ruleName: 'Human',
            groupIds: ['g1'],
            strategy: 'manual',
          },
        ],
      });
      const decision = await h.core.assign(base);
      expect(decision.outcome).toBe('queued');
      expect(decision.reasonKey).toBe('manualStrategy');
      expect(decision.groupId).toBe('g1');
      expect(h.load.reserveCalls).toBe(0);
      expect(h.commit.parked).toEqual(['g1']);
    });

    it('should let an explicit request strategy override the matched rule', async () => {
      const h = buildHarness({
        pool: ['a', 'b'],
        rules: [
          {
            ruleId: 'r1',
            ruleName: 'RR',
            groupIds: ['g1'],
            strategy: 'round-robin',
          },
        ],
        seedLoads: { a: 1, b: 0 },
      });
      h.candidates.members.set('g1', ['a', 'b']);
      const decision = await h.core.assign({ ...base, strategy: 'least-busy' });
      expect(decision.strategy).toBe('least-busy');
      expect(decision.assigneeId).toBe('b');
    });
  });

  describe('dry run', () => {
    it('should reserve nothing, commits nothing and audits nothing', async () => {
      const h = buildHarness({ pool: ['a'] });
      const decision = await h.core.assign({
        ...base,
        dryRun: true,
        explain: true,
      });
      expect(decision.assigneeId).toBe('a');
      expect(h.load.reserveCalls).toBe(0);
      expect(h.load.loadsByAgent.get('a') ?? 0).toBe(0);
      expect(h.commit.committed).toHaveLength(0);
      expect(h.audit.write).not.toHaveBeenCalled();
    });

    it('should report queued when every candidate is at capacity', async () => {
      const h = buildHarness({ pool: ['a'], seedLoads: { a: 5 } });
      const decision = await h.core.assign({ ...base, dryRun: true });
      expect(decision.outcome).toBe('queued');
      expect(decision.assigneeId).toBeNull();
    });
  });

  describe('audit', () => {
    it('should write exactly one row per decision', async () => {
      const h = buildHarness({ pool: ['a'] });
      await h.core.assign(base);
      expect(h.audit.write).toHaveBeenCalledTimes(1);
      expect(h.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          objectType: 'Ticket',
          entityId: 'e1',
          assigneeId: 'a',
          outcome: 'assigned',
          reasonKey: 'assigned',
        }),
      );
    });

    it('should write one row for a queued decision too', async () => {
      const h = buildHarness({ pool: [] });
      await h.core.assign(base);
      expect(h.audit.write).toHaveBeenCalledTimes(1);
      expect(h.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'queued' }),
      );
    });

    it('should record pre-create for a decision with no entity id', async () => {
      const h = buildHarness({ pool: ['a'] });
      await h.core.assign({ ...base, entityId: undefined });
      expect(h.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'pre-create' }),
      );
    });
  });

  describe('adapter registration', () => {
    it('should accept a late-registered adapter', async () => {
      const h = buildHarness({ pool: ['a'] });
      expect(h.core.hasAdapter('Conversation')).toBe(false);
      h.core.registerAdapter({
        objectTypes: ['Conversation'],
        candidates: new FakeCandidates(['x']) as any,
        load: new FakeLoad() as any,
        commit: new FakeCommit() as any,
      });
      expect(h.core.hasAdapter('Conversation')).toBe(true);
    });
  });
});

describe('mergeAssignmentConfig', () => {
  it('should resolve field by field: override ?? stored ?? default', () => {
    const resolved = mergeAssignmentConfig(
      {
        autoAssignEnabled: true,
        defaultStrategy: 'least-busy',
        defaultMaxCapacity: 7,
      } as any,
      { defaultStrategy: 'capacity-based' },
    );
    // Overridden.
    expect(resolved.defaultStrategy).toBe('capacity-based');
    // Inherited from the stored document, NOT reset by the override object.
    expect(resolved.defaultMaxCapacity).toBe(7);
    expect(resolved.autoAssignEnabled).toBe(true);
    // Hard default.
    expect(resolved.previousAssigneeTimeoutHours).toBe(72);
  });

  it('should produce every hard default from empty inputs', () => {
    const resolved = mergeAssignmentConfig(null, null);
    expect(resolved).toEqual({
      autoAssignEnabled: false,
      defaultStrategy: 'round-robin',
      defaultGroupId: null,
      defaultMaxCapacity: 10,
      fallbackOwnerId: null,
      stickyFallbackStrategy: 'round-robin',
      skillBasedRoutingEnabled: false,
      skillFallbackMode: 'lenient',
      requireOnline: false,
      preferPreviousAssignee: false,
      previousAssigneeTimeoutHours: 72,
      previousAssigneeWaitMinutes: 0,
    });
  });

  it('should normalise legacy snake_case strategies from stored documents', () => {
    expect(
      mergeAssignmentConfig({ defaultStrategy: 'round_robin' } as any)
        .defaultStrategy,
    ).toBe('round-robin');
    expect(
      mergeAssignmentConfig({ defaultStrategy: 'capacity_based' } as any)
        .defaultStrategy,
    ).toBe('capacity-based');
  });

  it('should collapse the retired sticky strategy onto the fallback', () => {
    // `sticky` is a preference now, not a strategy.
    expect(
      mergeAssignmentConfig({ defaultStrategy: 'sticky' } as any)
        .defaultStrategy,
    ).toBe('round-robin');
  });

  it('should not treat false as absent', () => {
    const resolved = mergeAssignmentConfig({ autoAssignEnabled: true } as any, {
      autoAssignEnabled: false,
    });
    expect(resolved.autoAssignEnabled).toBe(false);
  });

  it('should not treat 0 as absent', () => {
    const resolved = mergeAssignmentConfig(
      { previousAssigneeWaitMinutes: 5 } as any,
      { previousAssigneeWaitMinutes: 0 },
    );
    expect(resolved.previousAssigneeWaitMinutes).toBe(0);
  });
});
