import {
  CapabilityOverrideError,
  SEARCH_CAPABILITY_NAMES,
  capabilityDefinition,
  parseCapabilityOverrides,
  resolveCapability,
} from './search-capabilities';

const runtime = (
  openSearchEnabled: boolean,
  overrides: Record<string, 'mongodb' | 'off'> = {},
) => ({ openSearchEnabled, overrides: overrides as never });

describe('search capability registry', () => {
  describe('registry invariants', () => {
    it.each(SEARCH_CAPABILITY_NAMES)(
      '%s declares everything its tier requires',
      (name) => {
        const definition = capabilityDefinition(name);
        if (definition.owner === 'opensearch') {
          // A capability may not claim OpenSearch without saying what happens
          // when OpenSearch is gone. Leaving it unsaid is how a blanket
          // fallback got applied to capabilities MongoDB can only scan for.
          expect(definition.onOwnerUnavailable).toBeDefined();
        } else {
          expect(definition.onOwnerUnavailable).toBeUndefined();
        }
      },
    );

    it('should never lets a tier-E capability be owned by OpenSearch', () => {
      for (const name of SEARCH_CAPABILITY_NAMES) {
        const definition = capabilityDefinition(name);
        if (definition.tier === 'E') expect(definition.owner).toBe('mongodb');
      }
    });

    it('should require a user-facing sentence wherever degrading is allowed', () => {
      for (const name of SEARCH_CAPABILITY_NAMES) {
        const definition = capabilityDefinition(name);
        if (definition.onOwnerUnavailable !== 'degrade') continue;
        // If the degradation cannot be described to the person reading the
        // results, it has not been thought through and the policy should be
        // `off` instead.
        expect(definition.degradedSemantics?.length ?? 0).toBeGreaterThan(20);
      }
    });
  });

  describe('resolveCapability', () => {
    it('should route an OpenSearch-owned capability to OpenSearch when enabled', () => {
      expect(resolveCapability('global_search', runtime(true))).toMatchObject({
        engine: 'opensearch',
        disabled: false,
        divertedByConfig: false,
      });
    });

    it('should treat a configured MongoDB route as normal, not as degradation', () => {
      // The deployment never enabled OpenSearch. MongoDB answering is the
      // product working as configured; flagging it would put a permanent
      // warning in the UI and train everyone to ignore the real one.
      expect(resolveCapability('global_search', runtime(false))).toMatchObject({
        engine: 'mongodb',
        disabled: false,
        divertedByConfig: true,
        reason: 'opensearch_disabled',
      });
    });

    it('should keep tier-E capabilities on MongoDB whatever the flag says', () => {
      for (const enabled of [true, false]) {
        expect(resolveCapability('export', runtime(enabled))).toMatchObject({
          engine: 'mongodb',
          disabled: false,
          divertedByConfig: false,
        });
      }
    });

    it('should let an override narrow to MongoDB', () => {
      expect(
        resolveCapability(
          'global_search',
          runtime(true, { global_search: 'mongodb' }),
        ),
      ).toMatchObject({ engine: 'mongodb', reason: 'forced_to_mongodb' });
    });

    it('should let an override switch a capability off entirely', () => {
      expect(
        resolveCapability(
          'global_search',
          runtime(true, { global_search: 'off' }),
        ),
      ).toMatchObject({ disabled: true, reason: 'disabled_by_config' });
    });
  });

  describe('parseCapabilityOverrides', () => {
    it('should accept an empty or absent value', () => {
      expect(parseCapabilityOverrides(undefined)).toEqual({});
      expect(parseCapabilityOverrides('  ')).toEqual({});
    });

    it('should parse several entries', () => {
      expect(
        parseCapabilityOverrides('global_search:mongodb, export:off'),
      ).toEqual({ global_search: 'mongodb', export: 'off' });
    });

    it('should refuse an unknown capability rather than ignoring it', () => {
      // An override that silently does nothing is discovered during an
      // incident, which is the worst possible moment.
      expect(() => parseCapabilityOverrides('gloabl_search:off')).toThrow(
        CapabilityOverrideError,
      );
    });

    it('should refuse to widen a capability towards OpenSearch', () => {
      expect(() => parseCapabilityOverrides('export:opensearch')).toThrow(
        /may only narrow/,
      );
    });

    it('should refuse a malformed entry', () => {
      expect(() => parseCapabilityOverrides('global_search')).toThrow(
        CapabilityOverrideError,
      );
      expect(() => parseCapabilityOverrides('global_search:maybe')).toThrow(
        CapabilityOverrideError,
      );
    });

    it('should refuse "mongodb" for a capability with no index-backed MongoDB path', () => {
      // Guards the future: the moment a capability is added with policy `off`,
      // forcing it onto MongoDB must be rejected rather than quietly asking for
      // the scan the policy exists to prevent.
      const offPolicy = SEARCH_CAPABILITY_NAMES.find((name) => {
        const definition = capabilityDefinition(name);
        return (
          definition.owner === 'opensearch' &&
          definition.onOwnerUnavailable === 'off'
        );
      });
      if (!offPolicy) return;
      expect(() => parseCapabilityOverrides(`${offPolicy}:mongodb`)).toThrow(
        /no index-backed MongoDB path/,
      );
    });
  });
});
