import { Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  buildAgentReportVisibilityFilter,
  buildConversationReportVisibilityFilter,
  buildCrmReportVisibilityFilter,
} from './report-visibility-filter.util';

const id = (suffix: string) => `507f1f77bcf86cd7994390${suffix}`;
const asStrings = (value: unknown): unknown => {
  if (value instanceof Types.ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map(asStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, asStrings(child)]),
    );
  }
  return value;
};

const cls = (values: Record<string, unknown>) =>
  ({
    get: jest.fn((key: string) => values[key]),
  }) as unknown as ClsService;

describe('report visibility filter compiler', () => {
  it('should intersect a compiled report ABAC deny even for tenant-wide scope', () => {
    const deny = { $nor: [{ confidential: true }] };
    expect(
      buildCrmReportVisibilityFilter(
        cls({
          visibleOwnerIds: null,
          abacResourceFilter: {
            resource: 'deal_reports',
            filter: deny,
          },
        }),
        'Deal',
      ),
    ).toEqual({ $and: [deny] });
  });

  it('should not mix an unrelated report resource predicate into the pipeline', () => {
    expect(
      buildCrmReportVisibilityFilter(
        cls({
          visibleOwnerIds: null,
          abacResourceFilter: {
            resource: 'ticket_reports',
            filter: { $nor: [{ priority: 'high' }] },
          },
        }),
        'Deal',
      ),
    ).toEqual({});
  });

  it('should leave an explicit unrestricted CRM scope unchanged', () => {
    expect(
      buildCrmReportVisibilityFilter(cls({ visibleOwnerIds: null }), 'Deal'),
    ).toEqual({});
  });

  it('should union CRM owner and org-unit axes and exclude unowned by default', () => {
    const filter = buildCrmReportVisibilityFilter(
      cls({
        visibleOwnerIds: [id('11')],
        visibleOrgUnitIds: [id('12')],
      }),
      'Ticket',
    );
    expect(asStrings(filter)).toEqual({
      $and: [
        {
          $or: [
            { ownerId: { $in: [id('11')] } },
            { orgUnitId: { $in: [id('12')] } },
          ],
        },
      ],
    });
  });

  it('should prefer a module-specific scope over the request-wide scope', () => {
    const filter = buildCrmReportVisibilityFilter(
      cls({
        visibleOwnerIds: [id('11')],
        dataVisibilityByModule: {
          Deal: { ownerIds: [id('13')], orgUnitIds: [] },
        },
      }),
      'Deal',
    );
    expect(asStrings(filter)).toEqual({
      $and: [{ $or: [{ ownerId: { $in: [id('13')] } }] }],
    });
  });

  it('should enforce conversation owner, claim, group, org-unit and channel axes', () => {
    const filter = buildConversationReportVisibilityFilter(
      cls({
        visibleOwnerIds: [id('11')],
        visibleOrgUnitIds: [id('12')],
        visibleGroupIds: [id('13')],
        servableChannelIds: [id('14')],
      }),
    );
    expect(asStrings(filter)).toEqual({
      $and: [
        { channelId: { $in: [id('14')] } },
        {
          $or: [
            { assignedAgentId: { $in: [id('11')] } },
            { claimedById: { $in: [id('11')] } },
            { assignedGroupId: { $in: [id('13')] } },
            { orgUnitId: { $in: [id('12')] } },
          ],
        },
      ],
    });
  });

  it('should constrain agent reports to the conversation owner axis', () => {
    expect(
      buildAgentReportVisibilityFilter(
        cls({ visibleOwnerIds: ['agent-a', 'agent-b'] }),
      ),
    ).toEqual({ agentId: { $in: ['agent-a', 'agent-b'] } });
  });
});
