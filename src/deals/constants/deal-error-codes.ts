export const DEAL_ERRORS = {
  NOT_FOUND: 'DEAL_NOT_FOUND',
  ALREADY_WON: 'DEAL_ALREADY_WON',
  ALREADY_LOST: 'DEAL_ALREADY_LOST',
} as const;

export type DealErrorCode = (typeof DEAL_ERRORS)[keyof typeof DEAL_ERRORS];
