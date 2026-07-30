import { BadRequestException } from '@nestjs/common';
import { CustomFieldValueValidator } from './custom-field-value.validator';
import { CustomField } from './domain/custom-field';

const field = (overrides: Partial<CustomField>): CustomField =>
  ({
    id: 'f1',
    tenantId: 't1',
    module: 'Contact',
    internalKey: 'k',
    displayLabel: 'Field',
    fieldType: 'TEXT',
    isActive: true,
    section: '',
    orderIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as CustomField;

function makeValidator(fields: CustomField[]) {
  const service = { getByModule: jest.fn().mockResolvedValue(fields) };
  return {
    validator: new CustomFieldValueValidator(service as any),
    service,
  };
}

describe('CustomFieldValueValidator — coercion', () => {
  it('should coerce a numeric string to a number', async () => {
    // The same value arrives as a string from CSV import and as a number from
    // the API. Storing both as-is is what produced the type drift that split
    // report $group buckets.
    const { validator } = makeValidator([
      field({ internalKey: 'budget', fieldType: 'NUMBER' }),
    ]);
    const out = await validator.validate('Contact', { budget: '5' });
    expect(out).toEqual({ budget: 5 });
  });

  it('should reject a non-numeric value for a number field', async () => {
    const { validator } = makeValidator([
      field({
        internalKey: 'budget',
        fieldType: 'NUMBER',
        displayLabel: 'Budget',
      }),
    ]);
    await expect(
      validator.validate('Contact', { budget: 'lots' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject a decimal for a whole-number field', async () => {
    const { validator } = makeValidator([
      field({ internalKey: 'seats', fieldType: 'NUMBER' }),
    ]);
    await expect(
      validator.validate('Contact', { seats: '2.5' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should coerce CSV-style booleans', async () => {
    const { validator } = makeValidator([
      field({ internalKey: 'active', fieldType: 'BOOLEAN' }),
    ]);
    expect(await validator.validate('Contact', { active: 'yes' })).toEqual({
      active: true,
    });
    expect(await validator.validate('Contact', { active: '0' })).toEqual({
      active: false,
    });
  });

  it('should coerce a date string to a Date', async () => {
    const { validator } = makeValidator([
      field({ internalKey: 'renewal', fieldType: 'DATE' }),
    ]);
    const out: any = await validator.validate('Contact', {
      renewal: '2026-06-01',
    });
    expect(out.renewal).toBeInstanceOf(Date);
  });

  it('should reject an unparseable date', async () => {
    const { validator } = makeValidator([
      field({ internalKey: 'renewal', fieldType: 'DATE' }),
    ]);
    await expect(
      validator.validate('Contact', { renewal: 'soon' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should split a multi-select from a delimited string', async () => {
    const { validator } = makeValidator([
      field({
        internalKey: 'regions',
        fieldType: 'MULTI_SELECT',
        options: [
          { label: 'APAC', value: 'apac' },
          { label: 'EMEA', value: 'emea' },
        ],
      }),
    ]);
    expect(
      await validator.validate('Contact', { regions: 'apac; emea' }),
    ).toEqual({ regions: ['apac', 'emea'] });
  });

  it('should reject a value outside the declared picklist', async () => {
    const { validator } = makeValidator([
      field({
        internalKey: 'tier',
        fieldType: 'SINGLE_SELECT',
        options: [{ label: 'Gold', value: 'gold' }],
      }),
    ]);
    await expect(
      validator.validate('Contact', { tier: 'platinum' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should refuse a client-supplied formula value', async () => {
    // Accepting one would let a caller fake a computed number.
    const { validator } = makeValidator([
      field({ internalKey: 'ltv', fieldType: 'FORMULA' }),
    ]);
    await expect(validator.validate('Contact', { ltv: 999 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should enforce string length rules from the registry', async () => {
    const { validator } = makeValidator([
      field({
        internalKey: 'code',
        fieldType: 'TEXT',
        validation: { minLength: 3, maxLength: 5 },
      }),
    ]);
    await expect(validator.validate('Contact', { code: 'ab' })).rejects.toThrow(
      BadRequestException,
    );
    expect(await validator.validate('Contact', { code: 'abcd' })).toEqual({
      code: 'abcd',
    });
  });
});

describe('CustomFieldValueValidator — unknown keys', () => {
  it('should drop an undeclared key by default', async () => {
    // An integration sending an extra column must not start failing every write,
    // but the key must not become permanent undeclared schema either.
    const { validator } = makeValidator([
      field({ internalKey: 'known', fieldType: 'TEXT' }),
    ]);
    const out = await validator.validate('Contact', {
      known: 'a',
      typo: 'b',
    });
    expect(out).toEqual({ known: 'a' });
  });

  it('should reject an undeclared key in strict mode', async () => {
    const { validator } = makeValidator([
      field({ internalKey: 'known', fieldType: 'TEXT' }),
    ]);
    await expect(
      validator.validate('Contact', { typo: 'b' }, { strict: true }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CustomFieldValueValidator — required fields', () => {
  it('should require a field flagged isRequired on create', async () => {
    const { validator } = makeValidator([
      field({
        internalKey: 'segment',
        fieldType: 'TEXT',
        displayLabel: 'Segment',
        validation: { isRequired: true },
      }),
    ]);
    await expect(validator.validate('Contact', {})).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should NOT require it on a partial update', async () => {
    // A PATCH that does not mention the field was already satisfied at create.
    const { validator } = makeValidator([
      field({
        internalKey: 'segment',
        fieldType: 'TEXT',
        validation: { isRequired: true },
      }),
    ]);
    expect(await validator.validate('Contact', {}, { partial: true })).toEqual(
      {},
    );
  });
});

describe('CustomFieldValueValidator — edges', () => {
  it('should pass undefined straight through', async () => {
    const { validator, service } = makeValidator([]);
    expect(await validator.validate('Contact', undefined)).toBeUndefined();
    expect(service.getByModule).not.toHaveBeenCalled();
  });

  it('should reject an array or a scalar', async () => {
    const { validator } = makeValidator([]);
    await expect(validator.validate('Contact', [] as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should pass values through when the tenant defined no custom fields', async () => {
    // A tenant with an empty registry must still be able to save a record.
    const { validator } = makeValidator([]);
    expect(await validator.validate('Contact', { anything: 1 })).toEqual({
      anything: 1,
    });
  });

  it('should keep an explicit null so a user can clear a field', async () => {
    const { validator } = makeValidator([
      field({ internalKey: 'note', fieldType: 'TEXT' }),
    ]);
    expect(await validator.validate('Contact', { note: null })).toEqual({
      note: null,
    });
  });

  it('should fail OPEN when the registry cannot be read', async () => {
    // Custom-field validation is a data-quality control, not a security one; a
    // settings-service blip must not take record creation down.
    const service = {
      getByModule: jest.fn().mockRejectedValue(new Error('mongo down')),
    };
    const validator = new CustomFieldValueValidator(service as any);
    expect(await validator.validate('Contact', { budget: 'x' })).toEqual({
      budget: 'x',
    });
  });
});
