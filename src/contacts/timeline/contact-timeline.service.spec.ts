import { NotFoundException } from '@nestjs/common';
import { ContactTimelineService } from './contact-timeline.service';

const CONTACT = '60d0fe4f5311236168a109ca';
const TENANT = '60d0fe4f5311236168a109cc';

/** Rows keyed by collection; anything unlisted returns empty. */
function makeHarness(
  rows: Record<string, any[]>,
  contactOverrides: Record<string, unknown> = {},
) {
  const queried: Array<{ collection: string; filter: any; projection: any }> =
    [];

  const collection = jest.fn((name: string) => ({
    find: (filter: any, opts: any) => {
      queried.push({ collection: name, filter, projection: opts?.projection });
      return {
        sort: () => ({
          limit: () => ({ toArray: () => Promise.resolve(rows[name] ?? []) }),
        }),
      };
    },
  }));

  const contacts = {
    findOne: jest.fn(() =>
      Promise.resolve(
        contactOverrides === null
          ? null
          : { id: CONTACT, stageHistory: [], ...contactOverrides },
      ),
    ),
  };

  const service = new ContactTimelineService(
    contacts as any,
    { get: jest.fn(() => TENANT) } as any,
    { collection } as any,
  );

  return { service, contacts, collection, queried };
}

describe('ContactTimelineService — fan-in', () => {
  it('should merge every source into one reverse-chronological feed', async () => {
    // The point of the endpoint: seven tabs the user had to correlate by hand
    // become one ordered story.
    const { service } = makeHarness(
      {
        notes: [
          {
            _id: 'n1',
            title: 'Called back',
            createdAt: new Date('2026-03-01'),
          },
        ],
        tickets: [
          {
            _id: 't1',
            subject: 'Broken login',
            createdAt: new Date('2026-05-01'),
          },
        ],
        deals: [
          { _id: 'd1', name: 'Renewal', createdAt: new Date('2026-01-01') },
        ],
      },
      {
        stageHistory: [
          {
            fromStage: 'lead',
            toStage: 'customer',
            changedAt: new Date('2026-04-01'),
            changedById: 'u1',
          },
        ],
      },
    );

    const result = await service.getTimeline(CONTACT);

    expect(result.data.map((e) => e.source)).toEqual([
      'ticket', // May
      'stage_change', // April
      'note', // March
      'deal', // January
    ]);
  });

  it('should fold stage transitions in without an extra query', async () => {
    // stageHistory is embedded on the contact already loaded; querying for it
    // again would be a round-trip for data in hand.
    const { service, queried } = makeHarness(
      {},
      {
        stageHistory: [
          {
            fromStage: null,
            toStage: 'lead',
            changedAt: new Date('2026-01-01'),
            changedById: 'u1',
          },
        ],
      },
    );

    const result = await service.getTimeline(CONTACT);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      source: 'stage_change',
      title: 'Entered lead',
    });
    expect(queried.map((q) => q.collection)).not.toContain('contacts');
  });

  it('should date a completed task by its completion, not its creation', async () => {
    const { service } = makeHarness({
      tasks: [
        {
          _id: 'k1',
          title: 'Follow up',
          createdAt: new Date('2026-01-01'),
          completedAt: new Date('2026-06-01'),
        },
      ],
    });

    const [entry] = (await service.getTimeline(CONTACT)).data;
    expect(entry.type).toBe('task_completed');
    expect(entry.occurredAt).toEqual(new Date('2026-06-01'));
  });

  it('should match both relatedTo key shapes for tasks', async () => {
    // TaskRepository queries `_id` and the legacy `id`; missing one would drop
    // every task written before the rename.
    const { service, queried } = makeHarness({});
    await service.getTimeline(CONTACT);

    const taskQuery = queried.find((q) => q.collection === 'tasks');
    expect(taskQuery?.filter.$or).toEqual([
      { 'relatedTo._id': CONTACT },
      { 'relatedTo.id': CONTACT },
    ]);
  });

  it('should exclude soft-deleted related records', async () => {
    const { service, queried } = makeHarness({});
    await service.getTimeline(CONTACT);

    for (const name of ['tickets', 'deals', 'tasks']) {
      expect(queried.find((q) => q.collection === name)?.filter.deletedAt).toBe(
        null,
      );
    }
  });

  it('should project narrow field sets rather than whole documents', async () => {
    const { service, queried } = makeHarness({});
    await service.getTimeline(CONTACT);

    for (const query of queried) {
      expect(query.projection).toBeDefined();
      expect(Object.keys(query.projection).length).toBeLessThan(12);
    }
  });
});

describe('ContactTimelineService — scoping and limits', () => {
  it('should 404 through the repository, which applies visibility', async () => {
    // The timeline must not become a side door to a contact the caller cannot
    // otherwise read.
    const { service, contacts } = makeHarness({});
    contacts.findOne.mockResolvedValue(null);

    await expect(service.getTimeline(CONTACT)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should tenant-scope every source query', async () => {
    const { service, queried } = makeHarness({});
    await service.getTimeline(CONTACT);
    expect(queried.length).toBeGreaterThan(0);
    for (const query of queried) {
      expect(query.filter.tenantId).toBeDefined();
    }
  });

  it('should fetch only the requested sources', async () => {
    const { service, queried } = makeHarness({});
    await service.getTimeline(CONTACT, { sources: ['note', 'ticket'] });
    expect(queried.map((q) => q.collection).sort()).toEqual([
      'notes',
      'tickets',
    ]);
  });

  it('should honour the limit', async () => {
    const notes = Array.from({ length: 10 }, (_, i) => ({
      _id: `n${i}`,
      title: `Note ${i}`,
      createdAt: new Date(2026, 0, i + 1),
    }));
    const { service } = makeHarness({ notes });

    const result = await service.getTimeline(CONTACT, { limit: 3 });
    expect(result.data).toHaveLength(3);
  });

  it('should REPORT a capped source instead of implying the feed is complete', async () => {
    const notes = Array.from({ length: 50 }, (_, i) => ({
      _id: `n${i}`,
      title: `Note ${i}`,
      createdAt: new Date(2026, 0, 1),
    }));
    const { service } = makeHarness({ notes });

    const result = await service.getTimeline(CONTACT, { limit: 200 });
    expect(result.truncatedSources).toContain('note');
    expect(result.sourceCounts.note).toBe(50);
  });

  it('should degrade, not fail, when one source is unavailable', async () => {
    // A trimmed deployment missing a collection should cost those entries, not
    // the entire customer history.
    const { service, collection } = makeHarness({
      notes: [{ _id: 'n1', title: 'Kept', createdAt: new Date('2026-01-01') }],
    });
    collection.mockImplementation((name: string) => {
      if (name === 'tickets') throw new Error('collection missing');
      return {
        find: () => ({
          sort: () => ({
            limit: () => ({
              toArray: () =>
                Promise.resolve(
                  name === 'notes'
                    ? [
                        {
                          _id: 'n1',
                          title: 'Kept',
                          createdAt: new Date('2026-01-01'),
                        },
                      ]
                    : [],
                ),
            }),
          }),
        }),
      } as any;
    });

    const result = await service.getTimeline(CONTACT);
    expect(result.data.map((e) => e.title)).toEqual(['Kept']);
  });
});

describe('ContactTimelineService — rendering data', () => {
  it('should strip rich-text markup from a note excerpt', async () => {
    const { service } = makeHarness({
      notes: [
        {
          _id: 'n1',
          content: '<p>Customer asked about <b>pricing</b></p>',
          createdAt: new Date('2026-01-01'),
        },
      ],
    });

    const [entry] = (await service.getTimeline(CONTACT)).data;
    expect(entry.title).toBe('Customer asked about pricing');
    expect(entry.meta.excerpt).not.toContain('<');
  });

  it('should give click-through links to entries that have their own record', async () => {
    const { service } = makeHarness({
      tickets: [{ _id: 't1', subject: 'S', createdAt: new Date('2026-01-01') }],
    });
    const [entry] = (await service.getTimeline(CONTACT)).data;
    expect(entry.link).toEqual({ type: 'ticket', id: 't1' });
  });
});
