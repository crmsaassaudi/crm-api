import { ContactReportService } from './contact-report.service';
import { createClsMock } from '../../test/mocks/cls.mock';

describe('ContactReportService.getLeadConversion', () => {
  const tenantId = 'tenant_1';

  function build(lifecycleSetting: any) {
    const contactModel: any = { aggregate: jest.fn() };
    const dealModel: any = {};
    const settingsService: any = {
      getSetting: jest.fn().mockResolvedValue(lifecycleSetting),
    };
    const cls = createClsMock({ tenantId, activeTenantId: tenantId });
    const growthRollup: any = {};

    const service = new ContactReportService(
      contactModel,
      dealModel,
      settingsService,
      cls as any,
      growthRollup,
    );
    return { service, contactModel, settingsService };
  }

  it('reports as not configured when no stage is marked isLeadStage', async () => {
    const { service, contactModel } = build({
      stages: [
        { id: 'subscriber', apiName: 'subscriber', name: 'Subscriber' },
        { id: 'lead', apiName: 'lead', name: 'Lead' }, // no isLeadStage flag
      ],
    });

    const result = await service.getLeadConversion({ fromDate: '2026-01-01', toDate: '2026-12-31' } as any);

    expect(result.data.configured).toBe(false);
    expect(result.data.totalLeads).toBe(0);
    expect(result.meta.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('lead stage')]),
    );
    // The early-return path must not touch Mongo at all.
    expect(contactModel.aggregate).not.toHaveBeenCalled();
  });

  it('reports as not configured when the settings blob has no stages array', async () => {
    const { service } = build(undefined);

    const result = await service.getLeadConversion({ fromDate: '2026-01-01', toDate: '2026-12-31' } as any);

    expect(result.data.configured).toBe(false);
  });

  it('collects the apiName and label of every stage marked isLeadStage', async () => {
    const { service, contactModel } = build({
      stages: [
        { id: 'lead', apiName: 'lead', name: 'Lead', isLeadStage: true },
        {
          id: 'mql',
          apiName: 'mql',
          name: 'Marketing Qualified',
          isLeadStage: true,
        },
        { id: 'customer', apiName: 'customer', name: 'Customer' },
      ],
    });
    const aggregateResult: any = {
      exec: jest.fn().mockResolvedValue([]),
    };
    aggregateResult.allowDiskUse = jest.fn().mockReturnValue(aggregateResult);
    aggregateResult.option = jest.fn().mockReturnValue(aggregateResult);
    aggregateResult.read = jest.fn().mockReturnValue(aggregateResult);
    contactModel.aggregate.mockReturnValue(aggregateResult);

    const result = await service.getLeadConversion({ fromDate: '2026-01-01', toDate: '2026-12-31' } as any);

    expect(result.data.configured).toBe(true);
    expect(result.data.leadStageNames.sort()).toEqual(
      ['Lead', 'Marketing Qualified'].sort(),
    );
  });
});
