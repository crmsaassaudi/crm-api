/**
 * Common / generic error codes shared across all modules.
 * Module-specific error codes live in their own module directories.
 *
 * Convention: UPPER_SNAKE_CASE, prefixed by module name.
 *   e.g. TENANT_NOT_FOUND, OMNI_REPLY_WINDOW_EXPIRED
 */

export const COMMON_ERRORS = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  ENTITY_NOT_FOUND: 'ENTITY_NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
} as const;

/** Union of all common error code values */
export type CommonErrorCode =
  (typeof COMMON_ERRORS)[keyof typeof COMMON_ERRORS];
