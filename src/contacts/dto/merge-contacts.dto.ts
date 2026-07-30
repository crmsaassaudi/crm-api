import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  ValidateBy,
  ValidationOptions,
} from 'class-validator';

const MERGE_SOURCES = ['survivor', 'merged'] as const;

/**
 * Every value of a record must be one of `survivor` / `merged`.
 *
 * A custom constraint rather than `@IsIn([...], { each: true })`: `each` iterates
 * ARRAYS, not object values, so on a `Record` it hands the whole object to the
 * `isIn` check, which fails. The effect was the opposite of validation — it
 * rejected every *valid* `fieldWinners` payload with a 422, so the field picker
 * in the merge dialog would never have worked. Caught by
 * `merge-contacts.dto.spec.ts`, which is why that spec exists.
 */
function IsMergeSourceMap(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isMergeSourceMap',
      validator: {
        validate: (value: unknown) => {
          if (value === undefined || value === null) return true;
          if (typeof value !== 'object' || Array.isArray(value)) return false;
          return Object.values(value as Record<string, unknown>).every((v) =>
            (MERGE_SOURCES as readonly unknown[]).includes(v),
          );
        },
        defaultMessage: () =>
          `each value of fieldWinners must be one of: ${MERGE_SOURCES.join(', ')}`,
      },
    },
    validationOptions,
  );
}

/**
 * Optional per-field survivorship overrides for a contact merge.
 *
 * Omitted entirely, the merge applies the default rules (union the identity
 * arrays, fill the survivor's blanks from the loser, never widen consent) — so
 * the existing single-click merge keeps working unchanged. Supplying
 * `fieldWinners` is what lets the merge dialog offer a side-by-side picker:
 * `{ "firstName": "merged" }` takes the loser's value even though the survivor
 * has one.
 *
 * Identity arrays are deliberately NOT overridable. "Choose one" there means
 * deliberately throwing away a phone number or an email address, which is the
 * one outcome a merge must never produce.
 */
export class MergeContactsDto {
  @ApiPropertyOptional({
    description:
      'Per-field winner for scalar fields: { fieldName: "survivor" | "merged" }.',
    example: { firstName: 'merged', title: 'survivor' },
    type: 'object',
    additionalProperties: { type: 'string', enum: ['survivor', 'merged'] },
  })
  @IsOptional()
  @IsObject()
  @IsMergeSourceMap()
  fieldWinners?: Record<string, 'survivor' | 'merged'>;
}
