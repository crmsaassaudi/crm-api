import { loadCustomFieldExportColumns } from './custom-field-export-columns';

describe('loadCustomFieldExportColumns', () => {
  it('should add active non-sensitive registry fields only', async () => {
    const registry = {
      getByModule: jest.fn().mockResolvedValue([
        {
          internalKey: 'tier',
          displayLabel: 'Customer tier',
          isActive: true,
          orderIndex: 2,
        },
        {
          internalKey: 'secret',
          displayLabel: 'Secret',
          isActive: true,
          orderIndex: 1,
          governance: { isSensitive: true },
        },
      ]),
    };

    await expect(
      loadCustomFieldExportColumns(registry as any, 'Contact'),
    ).resolves.toEqual([
      {
        path: 'customFields.tier',
        header: 'Customer tier',
        maskKey: 'customFields.tier',
      },
    ]);
  });
});
