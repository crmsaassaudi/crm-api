import { SetMetadata } from '@nestjs/common';
import { ConfigurableObject } from '../object-registry';

export const OBJECT_FIELD_POLICY_KEY = 'object_field_policy';

/**
 * Marks a controller (or handler) as serving records of `object`, so
 * `FieldPolicyInterceptor` can apply the tenant's field-level policy to what goes
 * out and what is accepted in.
 *
 * Typed to `ConfigurableObject` rather than `string`, which is not cosmetic: the
 * decorator it replaces took a free-form name, and `@MaskedResource('Lead')` on a
 * contacts route quietly selected a layout key nothing else wrote.
 */
export const ObjectFieldPolicy = (object: ConfigurableObject) =>
  SetMetadata(OBJECT_FIELD_POLICY_KEY, object);
