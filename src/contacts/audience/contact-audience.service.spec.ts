import { BadRequestException } from '@nestjs/common';
import { ContactAudienceService } from './contact-audience.service';
import { AudienceDefinition } from './audience-definition';

/**
 * The audience resolver decides who a campaign reaches, so its failure mode is
 * not "too few" — it is "everyone", or "someone the sender was never allowed to
 * see". Both are pinned here.
 */
describe('ContactAudienceService', () => {
  const segments = {
    buildMembershipFilter: jest.fn(async (id: string) => ({ segment: id })),
    compileDraft: jest.fn(async (filter: any) => ({
      compiled: filter.conditions.length,
    })),
  };

  const build = (clsValues: Record<string, unknown> = {}) =>
    new ContactAudienceService(segments as any, {
      get: (key: string) => clsValues[key],
    } as any);

  const audience = (
    definition: Partial<AudienceDefinition>,
  ): AudienceDefinition => ({ include: [], exclude: [], ...definition });

  beforeEach(() => jest.clearAllMocks());

  it('should exclude soft-deleted contacts, which the filter compiler knows nothing about', async () => {
    const filter = await build().buildFilter(
      audience({ include: [{ type: 'segment', segmentId: 'seg_1' }] }),
    );
    expect(filter.$and).toContainEqual({ deletedAt: null });
  });

  it('should union several include sources rather than intersect them', async () => {
    const filter = await build().buildFilter(
      audience({
        include: [
          { type: 'segment', segmentId: 'seg_1' },
          { type: 'segment', segmentId: 'seg_2' },
        ],
      }),
    );
    expect(filter.$and).toContainEqual({
      $or: [{ segment: 'seg_1' }, { segment: 'seg_2' }],
    });
  });

  /** A single source is passed through flat: `$or` of one is noise the planner has to unwrap. */
  it('should not wrap a lone include source in $or', async () => {
    const filter = await build().buildFilter(
      audience({ include: [{ type: 'segment', segmentId: 'seg_1' }] }),
    );
    expect(filter.$and).toContainEqual({ segment: 'seg_1' });
  });

  it('should subtract every exclusion with a single $nor', async () => {
    const filter = await build().buildFilter(
      audience({
        include: [{ type: 'segment', segmentId: 'seg_1' }],
        exclude: [
          { type: 'segment', segmentId: 'seg_2' },
          { type: 'segment', segmentId: 'seg_3' },
        ],
      }),
    );
    expect(filter.$and).toContainEqual({
      $nor: [{ segment: 'seg_2' }, { segment: 'seg_3' }],
    });
  });

  it('should add no exclusion clause when nothing is excluded', async () => {
    const filter = await build().buildFilter(
      audience({ include: [{ type: 'segment', segmentId: 'seg_1' }] }),
    );
    expect(JSON.stringify(filter)).not.toContain('$nor');
  });

  it('should compile an inline filter through the shared contact compiler', async () => {
    await build().buildFilter(
      audience({
        include: [
          {
            type: 'filter',
            filter: {
              match: 'any',
              conditions: [{ field: 'city', operator: 'eq', value: 'Riyadh' }],
            },
          },
        ],
      }),
    );
    expect(segments.compileDraft).toHaveBeenCalledTimes(1);
    expect(segments.buildMembershipFilter).not.toHaveBeenCalled();
  });

  /**
   * The one that matters most. An audience walk reads contacts through the model
   * rather than the repository, so nothing else applies row-level visibility —
   * and a campaign that reaches people its author cannot open is a disclosure.
   */
  it('should narrow the audience to what the caller may read', async () => {
    const filter = await build({ visibleOwnerIds: ['user_1'] }).buildFilter(
      audience({ include: [{ type: 'segment', segmentId: 'seg_1' }] }),
    );
    expect(filter.$and).toContainEqual({
      $or: [{ ownerId: { $in: ['user_1'] } }],
    });
  });

  it('should add no owner clause for a caller with unrestricted visibility', async () => {
    const filter = await build({ visibleOwnerIds: null }).buildFilter(
      audience({ include: [{ type: 'segment', segmentId: 'seg_1' }] }),
    );
    expect(JSON.stringify(filter)).not.toContain('ownerId');
  });

  // ── Refusals ───────────────────────────────────────────────────────
  // Each of these would otherwise resolve to a predicate that quietly selects
  // every contact in the tenant.

  it('should refuse an audience with no include source', async () => {
    await expect(build().buildFilter(audience({}))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should refuse a filter source with no conditions', async () => {
    await expect(
      build().buildFilter(
        audience({
          include: [{ type: 'filter', filter: { match: 'all', conditions: [] } }],
        }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('should refuse a segment source with no segment', async () => {
    await expect(
      build().buildFilter(audience({ include: [{ type: 'segment' }] })),
    ).rejects.toThrow(BadRequestException);
  });

  it('should refuse an unknown source type', async () => {
    await expect(
      build().buildFilter(
        audience({ include: [{ type: 'everyone' } as any] }),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});
