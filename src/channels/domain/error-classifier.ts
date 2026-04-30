/**
 * Error Classifier — Categorizes provider errors as Transient or Permanent.
 *
 * Used by:
 *   - Smart Retry Engine (ActionExecutors) — decide retry vs drop
 *   - Health Check Service — decide status update
 *   - Alert Service — decide severity level
 *
 * Classification Table:
 *   401 Unauthorized → PERMANENT (bad API key)
 *   403 Forbidden    → PERMANENT (revoked/restricted)
 *   429 Too Many     → TRANSIENT (rate limited, auto-recovers)
 *   500 Server Error → TRANSIENT (provider-side issue)
 *   502/503/504      → TRANSIENT (upstream issue)
 *   ECONNRESET       → TRANSIENT (network blip)
 *   ETIMEDOUT        → TRANSIENT (network timeout)
 *   Other            → PERMANENT (unknown, play safe)
 */

export enum ErrorSeverity {
  /** Retryable: 429, 500, 502, 503, 504, timeout, network errors */
  TRANSIENT = 'transient',
  /** Non-retryable: 401, 403, invalid config — drop to DLQ immediately */
  PERMANENT = 'permanent',
}

export interface ClassifiedError {
  severity: ErrorSeverity;
  httpStatus?: number;
  code: string;
  message: string;
  /** If true, the channel config status should be updated to 'error' */
  shouldUpdateConfigStatus: boolean;
}

// ── HTTP status codes that indicate transient (retryable) issues ──────────
const TRANSIENT_HTTP_CODES = new Set([429, 500, 502, 503, 504]);

// ── Network error codes that indicate transient issues ───────────────────
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Classify a provider error from HTTP response or network failure.
 *
 * @param error - The raw error object (may contain httpStatus, code, status, etc.)
 * @returns ClassifiedError with severity and metadata
 */
export function classifyProviderError(error: any): ClassifiedError {
  // ── Extract HTTP status from various error shapes ──────────────────
  const httpStatus: number | undefined =
    error.httpStatus ||
    error.status ||
    error.statusCode ||
    error.response?.status ||
    error.response?.statusCode;

  // ── Extract error code ─────────────────────────────────────────────
  const errorCode: string =
    error.code || error.errno || error.cause?.code || '';

  const message = error.message || error.toString() || 'Unknown provider error';

  // ── 1. Check HTTP status-based classification ──────────────────────
  if (httpStatus) {
    if (TRANSIENT_HTTP_CODES.has(httpStatus)) {
      return {
        severity: ErrorSeverity.TRANSIENT,
        httpStatus,
        code: `HTTP_${httpStatus}`,
        message,
        shouldUpdateConfigStatus: false, // Don't mark config as error for transient issues
      };
    }

    // 401/403 = credential problem → permanent
    if (httpStatus === 401 || httpStatus === 403) {
      return {
        severity: ErrorSeverity.PERMANENT,
        httpStatus,
        code: `HTTP_${httpStatus}`,
        message,
        shouldUpdateConfigStatus: true, // Mark config as 'error'
      };
    }
  }

  // ── 2. Check network error code ────────────────────────────────────
  if (errorCode && TRANSIENT_NETWORK_CODES.has(errorCode)) {
    return {
      severity: ErrorSeverity.TRANSIENT,
      code: errorCode,
      message,
      shouldUpdateConfigStatus: false,
    };
  }

  // ── 3. Check for timeout in message (fallback heuristic) ───────────
  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('socket hang up')
  ) {
    return {
      severity: ErrorSeverity.TRANSIENT,
      code: 'NETWORK_TIMEOUT',
      message,
      shouldUpdateConfigStatus: false,
    };
  }

  // ── 4. Default: treat unknown errors as permanent ──────────────────
  // Better to alert admin than silently retry forever
  return {
    severity: ErrorSeverity.PERMANENT,
    httpStatus,
    code: errorCode || 'UNKNOWN_ERROR',
    message,
    shouldUpdateConfigStatus: false, // Don't auto-mark for unknown errors
  };
}
