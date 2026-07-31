import type { CustomFieldsService } from '../../custom-fields/custom-fields.service';
import type { ExportColumn } from './types';

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export const loadCustomFieldExportColumns = async (
  registry: CustomFieldsService | undefined,
  module: string,
): Promise<ExportColumn[]> => {
  if (!registry) return [];
  const fields = await registry.getByModule(module);
  return fields
    .filter(
      (field) =>
        field.isActive &&
        !field.governance?.isSensitive &&
        SAFE_KEY.test(field.internalKey),
    )
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((field) => ({
      path: `customFields.${field.internalKey}`,
      header: field.displayLabel,
      maskKey: `customFields.${field.internalKey}`,
    }));
};
