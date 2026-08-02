import { ImportErrorCode } from '../../common/import';
import { TicketImportProcessor } from './ticket-import.processor';

describe('TicketImportProcessor row validation', () => {
  const processor = Object.create(TicketImportProcessor.prototype) as any;

  it('should reject a row without a subject', () => {
    const errors = processor.validateRow(
      { row: 2, fields: {}, arrayFields: { tags: [] } },
      {},
    );
    expect(errors).toContainEqual(
      expect.objectContaining({
        row: 2,
        field: 'subject',
        code: ImportErrorCode.REQUIRED_FIELD_MISSING,
      }),
    );
  });

  it('should reject oversized fields and tag collections', () => {
    const errors = processor.validateRow(
      {
        row: 3,
        fields: { subject: 'x'.repeat(501), description: 'x'.repeat(50_001) },
        arrayFields: {
          tags: Array.from({ length: 101 }, (_, index) => String(index)),
        },
      },
      {},
    );
    expect(errors).toHaveLength(3);
    expect(
      errors.every(
        (error: any) => error.code === ImportErrorCode.VALIDATION_FAILED,
      ),
    ).toBe(true);
  });

  it('should accept a bounded valid row', () => {
    expect(
      processor.validateRow(
        {
          row: 4,
          fields: { subject: 'Valid', description: 'Details' },
          arrayFields: { tags: [] },
        },
        {},
      ),
    ).toEqual([]);
  });
});
