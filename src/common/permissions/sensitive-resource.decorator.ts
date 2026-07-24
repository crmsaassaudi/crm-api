import { SetMetadata } from '@nestjs/common';

export const SENSITIVE_RESOURCE_KEY = 'sensitive_resource';

/**
 * Mark a handler/controller whose response carries sensitive fields for a
 * resource. The FieldMaskingInterceptor masks those fields unless the acting
 * principal holds the field's unmask permission.
 *
 *   @SensitiveResource('contacts')
 *   @Get() findAll() { ... }
 */
export const SensitiveResource = (resource: string) =>
  SetMetadata(SENSITIVE_RESOURCE_KEY, resource);
