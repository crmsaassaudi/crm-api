import { UnprocessableEntityException } from '@nestjs/common';
import { ObjectRegistryService } from '../object-registry.service';
import { ResolvedFieldPolicy } from '../layout/field-policy';
import { RecordWriteValidator } from './record-write-validator.service';
import { ValidationRule } from './validation-rule';

const emptyPolicy: ResolvedFieldPolicy = {
  hidden: new Set(),
  readOnly: new Set(),
  masking: new Map(),
  required: new Set(),
};

const build = (
  policy: Partial<ResolvedFieldPolicy> = {},
  rules: Record<string, ValidationRule[]> = {},
  picklists: Record<string, Array<{ label: string; value: string }>> = {},
) => {
  const layouts = {
    policyFor: jest.fn().mockResolvedValue({ ...emptyPolicy, ...policy }),
  };
  const settings = {
    getSetting: jest.fn().mockResolvedValue({ rules }),
  };
  const picklistProvider = {
    forObject: jest.fn().mockResolvedValue(picklists),
  };
  const validator = new RecordWriteValidator(
    layouts as any,
    settings as any,
    new ObjectRegistryService(),
    picklistProvider as any,
  );
  return { validator, layouts, settings, picklistProvider };
};

const errorsOf = async (
  promise: Promise<unknown>,
): Promise<Record<string, string>> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    const response = (error as UnprocessableEntityException).getResponse() as {
      errors: Record<string, string>;
    };
    return response.errors;
  }
  throw new Error('expected the write to be rejected');
};

describe('RecordWriteValidator', () => {
  describe('required fields', () => {
    it('should reject a create missing a required field', async () => {
      const { validator } = build({ required: new Set(['typeId']) });
      const errors = await errorsOf(
        validator.assertValid('Ticket', { subject: 'Hi' }, 'create'),
      );
      expect(errors).toEqual({ typeId: 'typeId is required' });
    });

    it.each([undefined, null, '', []])(
      'should treat %p as missing',
      async (value) => {
        const { validator } = build({ required: new Set(['typeId']) });
        await expect(
          validator.assertValid('Ticket', { typeId: value }, 'create'),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      },
    );

    it('should accept a create that supplies it', async () => {
      const { validator } = build({ required: new Set(['typeId']) });
      await expect(
        validator.assertValid('Ticket', { typeId: 'abc' }, 'create'),
      ).resolves.toBeUndefined();
    });

    it('should not require a field absent from an update', async () => {
      // Otherwise every PATCH would have to resend the whole record.
      const { validator } = build({ required: new Set(['typeId']) });
      await expect(
        validator.assertValid('Ticket', { subject: 'Hi' }, 'update'),
      ).resolves.toBeUndefined();
    });

    it('should reject an update that clears a required field', async () => {
      const { validator } = build({ required: new Set(['typeId']) });
      await expect(
        validator.assertValid('Ticket', { typeId: '' }, 'update'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('validation rules', () => {
    const emailFormat: ValidationRule = {
      id: 'r1',
      name: 'Email format',
      field: 'emails',
      operator: 'regex',
      value: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
      errorMessage: 'Please enter a valid email address.',
      isActive: true,
    };

    it('should apply a rule on create', async () => {
      const { validator } = build({}, { Contact: [emailFormat] });
      const errors = await errorsOf(
        validator.assertValid('Contact', { emails: 'nope' }, 'create'),
      );
      expect(errors).toEqual({ emails: 'Please enter a valid email address.' });
    });

    it('should report the tenant’s own message', async () => {
      const { validator } = build(
        {},
        {
          Contact: [
            { ...emailFormat, errorMessage: 'Bạn cần nhập email hợp lệ.' },
          ],
        },
      );
      const errors = await errorsOf(
        validator.assertValid('Contact', { emails: 'nope' }, 'create'),
      );
      expect(errors.emails).toBe('Bạn cần nhập email hợp lệ.');
    });

    it('should resolve a rule stored against a column key', async () => {
      const { validator } = build(
        {},
        {
          Deal: [
            {
              id: 'r2',
              name: 'Amount range',
              field: 'amount',
              operator: 'range',
              value: '1-1000',
              errorMessage: 'Out of range',
              isActive: true,
            },
          ],
        },
      );
      const errors = await errorsOf(
        validator.assertValid('Deal', { value: 5000 }, 'create'),
      );
      // Stored as `amount`; enforced against the payload key `value`.
      expect(errors).toEqual({ value: 'Out of range' });
    });

    it('should ignore an inactive rule', async () => {
      const { validator } = build(
        {},
        { Contact: [{ ...emailFormat, isActive: false }] },
      );
      await expect(
        validator.assertValid('Contact', { emails: 'nope' }, 'create'),
      ).resolves.toBeUndefined();
    });

    it('should ignore a rule for an unknown field', async () => {
      const { validator } = build(
        {},
        { Contact: [{ ...emailFormat, field: 'retired' }] },
      );
      await expect(
        validator.assertValid('Contact', { emails: 'nope' }, 'create'),
      ).resolves.toBeUndefined();
    });

    it('should skip a rule on a field absent from an update', async () => {
      const { validator } = build({}, { Contact: [emailFormat] });
      await expect(
        validator.assertValid('Contact', { title: 'CTO' }, 'update'),
      ).resolves.toBeUndefined();
    });

    it('should not apply a rule to a server-owned field', async () => {
      const { validator } = build(
        {},
        {
          Contact: [
            {
              id: 'r3',
              name: 'Score range',
              field: 'score',
              operator: 'range',
              value: '80-100',
              errorMessage: 'Too low',
              isActive: true,
            },
          ],
        },
      );
      await expect(
        validator.assertValid('Contact', { score: 10 }, 'create'),
      ).resolves.toBeUndefined();
    });

    it('should report required and rule failures together', async () => {
      const { validator } = build(
        { required: new Set(['title']) },
        { Contact: [emailFormat] },
      );
      const errors = await errorsOf(
        validator.assertValid('Contact', { emails: 'nope' }, 'create'),
      );
      expect(Object.keys(errors).sort()).toEqual(['emails', 'title']);
    });

    it('should keep the required message when a rule targets the same field', async () => {
      // One message per field: the first failure reported is the required one,
      // because "you left it blank" is more actionable than a format complaint
      // about an empty string.
      const { validator } = build(
        { required: new Set(['emails']) },
        { Contact: [{ ...emailFormat, operator: 'not_empty' }] },
      );
      const errors = await errorsOf(
        validator.assertValid('Contact', { emails: '' }, 'create'),
      );
      expect(errors.emails).toBe('emails is required');
    });
  });

  describe('picklist values', () => {
    const stages = [
      { label: 'Qualification', value: '60d0fe4f5311236168a109cd' },
      { label: 'Won', value: '60d0fe4f5311236168a109ce' },
    ];

    it('should reject a value the tenant has not configured', async () => {
      // The quiet half of the split-brain: Deal validated nothing, so a stageId
      // from the old settings blob was stored and then resolved nowhere.
      const { validator } = build({}, {}, { stageId: stages });
      const errors = await errorsOf(
        validator.assertValid('Deal', { stageId: 'qualification' }, 'create'),
      );
      expect(errors.stageId).toMatch(/configured value/);
    });

    it('should accept a configured value', async () => {
      const { validator } = build({}, {}, { stageId: stages });
      await expect(
        validator.assertValid('Deal', { stageId: stages[0].value }, 'create'),
      ).resolves.toBeUndefined();
    });

    it('should skip validation when the tenant has configured nothing', async () => {
      // A tenant with no statuses yet must still be able to save a record.
      const { validator } = build({}, {}, { stageId: [] });
      await expect(
        validator.assertValid('Deal', { stageId: 'anything' }, 'create'),
      ).resolves.toBeUndefined();
    });

    it('should allow clearing an optional picklist', async () => {
      const { validator } = build({}, {}, { stageId: stages });
      await expect(
        validator.assertValid('Deal', { stageId: '' }, 'create'),
      ).resolves.toBeUndefined();
    });

    it('should check every entry of a multi-value picklist', async () => {
      const { validator } = build({}, {}, { contactIds: stages });
      const errors = await errorsOf(
        validator.assertValid(
          'Deal',
          { contactIds: [stages[0].value, 'bogus'] },
          'create',
        ),
      );
      expect(errors.contactIds).toBeDefined();
    });

    it('should ignore a field absent from the payload', async () => {
      const { validator } = build({}, {}, { stageId: stages });
      await expect(
        validator.assertValid('Deal', { title: 'New deal' }, 'update'),
      ).resolves.toBeUndefined();
    });
  });

  describe('fail-open on a settings read failure', () => {
    it('should allow the write when validation rules cannot be loaded', async () => {
      // Data-quality control, not a security control: a settings blip must not
      // take record creation down.
      const { validator, settings } = build();
      settings.getSetting.mockRejectedValue(new Error('mongo down'));
      await expect(
        validator.assertValid('Contact', { emails: 'nope' }, 'create'),
      ).resolves.toBeUndefined();
    });
  });
});
