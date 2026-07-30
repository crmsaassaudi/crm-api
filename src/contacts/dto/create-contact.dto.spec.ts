import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateContactDto } from './create-contact.dto';
import { UpdateContactDto } from './update-contact.dto';

/**
 * These DTOs carry the identity-normalisation gate (`@Transform`), so this suite
 * pins two things that are easy to assume and wrong to assume:
 *
 *   1. that the transform runs at all, and
 *   2. that it runs BEFORE validation — otherwise `@IsEmail` would judge the raw
 *      client value while storage got the normalised one, and the two would
 *      disagree about what is acceptable.
 *
 * `plainToInstance` + `validate` is exactly what the global ValidationPipe does
 * (`transform: true`), so passing here means passing in the request path.
 */
const build = (payload: unknown) =>
  plainToInstance(CreateContactDto, payload, {
    enableImplicitConversion: false,
  });

describe('CreateContactDto — identity normalisation', () => {
  it('should lower-case emails during transformation', () => {
    const dto = build({
      firstName: 'A',
      lastName: 'B',
      emails: ['John@Acme.COM'],
    });
    expect(dto.emails).toEqual(['john@acme.com']);
  });

  it('should compact phones and keep a leading +', () => {
    const dto = build({
      firstName: 'A',
      lastName: 'B',
      phones: ['+84 90 111 2222'],
    });
    expect(dto.phones).toEqual(['+84901112222']);
  });

  it('should de-duplicate identities that differ only by case', () => {
    const dto = build({
      firstName: 'A',
      lastName: 'B',
      emails: ['A@x.com', 'a@X.com'],
    });
    expect(dto.emails).toEqual(['a@x.com']);
  });

  it('should leave emails undefined when the field is absent', () => {
    // A PATCH that does not mention emails must not be turned into "set emails
    // to []", which would erase every address on the contact.
    const dto = build({ firstName: 'A', lastName: 'B' });
    expect(dto.emails).toBeUndefined();
  });

  it('should normalise BEFORE validating, so a mixed-case address passes', async () => {
    const errors = await validate(
      build({ firstName: 'A', lastName: 'B', emails: ['John@Acme.COM'] }),
    );
    expect(errors).toHaveLength(0);
  });

  it('should still reject a genuinely invalid email after normalising', async () => {
    const errors = await validate(
      build({ firstName: 'A', lastName: 'B', emails: ['not-an-email'] }),
    );
    expect(errors.map((e) => e.property)).toContain('emails');
  });

  it('should reject customFields that is not an object', async () => {
    const errors = await validate(
      build({ firstName: 'A', lastName: 'B', customFields: 'nope' }),
    );
    expect(errors.map((e) => e.property)).toContain('customFields');
  });

  it('should not expose isShadow as a settable field', () => {
    // Server-owned: set only by the omni shadow-contact pipeline. With
    // `forbidNonWhitelisted` on the global pipe, a client sending it now gets a
    // 422 instead of writing a record that reports exclude.
    expect('isShadow' in new CreateContactDto()).toBe(false);
  });
});

describe('UpdateContactDto — inherits the same gate', () => {
  it('should normalise on update too', () => {
    const dto = plainToInstance(UpdateContactDto, {
      emails: ['  MiXeD@Case.IO '],
      phones: ['(090) 123-4567'],
    });
    expect(dto.emails).toEqual(['mixed@case.io']);
    expect(dto.phones).toEqual(['0901234567']);
  });
});
