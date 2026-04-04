export const SLA_ERRORS = {
  POLICY_NOT_FOUND: 'SLA_POLICY_NOT_FOUND',
  BREACH_CALCULATION_FAILED: 'SLA_BREACH_CALCULATION_FAILED',
} as const;

export type SlaErrorCode = (typeof SLA_ERRORS)[keyof typeof SLA_ERRORS];
