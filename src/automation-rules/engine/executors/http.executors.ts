import { Injectable, Logger } from '@nestjs/common';
import { ActionExecutionResult, ActionExecutor } from './executor.interface';
import { AutomationActionJobData } from '../../queue/automation-queue.constants';
import { TemplateInterpolationService } from '../template-interpolation.service';
import { CrmRecordUpdateService } from '../crm-record-update.service';
import {
  SsrfBlockedError,
  SsrfGuardService,
} from '../../../common/http/ssrf-guard.service';
import { WebhookHeaderCryptoService } from '../webhook-header-crypto.service';

/** Hard timeout for any outbound automation HTTP call. */
const HTTP_HARD_TIMEOUT_MS = 5000;
/** Max response body read, to prevent a memory bomb from a hostile endpoint. */
const HTTP_RESPONSE_MAX_BYTES = 65_536; // 64 KB
/** Deepest dot-path a response mapping may traverse. */
const MAX_RESPONSE_PATH_DEPTH = 10;

/** Keys that would let a crafted JSON response pollute Object.prototype. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Safely traverse a nested object by dot-path. */
function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  if (parts.length > MAX_RESPONSE_PATH_DEPTH) return undefined;
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    if (UNSAFE_KEYS.has(part)) return undefined;
    current = current[part];
  }
  return current;
}

/** Read a response body up to the cap, then abandon the rest. */
async function readResponseCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  try {
    while (totalSize < HTTP_RESPONSE_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalSize += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const size = Math.min(totalSize, HTTP_RESPONSE_MAX_BYTES);
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const copyLen = Math.min(chunk.length, size - offset);
    merged.set(chunk.subarray(0, copyLen), offset);
    offset += copyLen;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Turn a thrown fetch error into a result.
 *
 * A blocked destination is a configuration problem, not a transient one —
 * retrying it three times just repeats the same denial.
 */
function classifyHttpError(
  error: any,
  url: string,
  logger: Logger,
  timeoutCode: string,
): ActionExecutionResult {
  if (error instanceof SsrfBlockedError) {
    logger.warn(`SSRF BLOCKED: ${url} — ${error.message}`);
    return {
      success: false,
      retryable: false,
      error: { code: 'SSRF_BLOCKED', message: error.message },
    };
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    logger.warn(`TIMEOUT after ${HTTP_HARD_TIMEOUT_MS}ms: ${url}`);
    return {
      success: false,
      error: {
        code: timeoutCode,
        message: `Request to ${url} timed out after ${HTTP_HARD_TIMEOUT_MS}ms`,
      },
    };
  }
  logger.error(`Request failed: ${error.message}`, error.stack);
  return {
    success: false,
    error: { code: 'HTTP_ERROR', message: error.message },
  };
}

// Webhook — fire-and-forget notification to an external endpoint

@Injectable()
export class WebhookExecutor implements ActionExecutor {
  readonly actionType = 'webhook';
  private readonly logger = new Logger(WebhookExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    private readonly ssrfGuard: SsrfGuardService,
    private readonly webhookHeaderCrypto: WebhookHeaderCryptoService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { actionConfig, recordData, tenantId } = job;
    const url = actionConfig.webhookUrl;
    const method = (actionConfig.method ?? 'POST').toUpperCase();

    if (!url) {
      return {
        success: false,
        retryable: false,
        error: { code: 'NO_WEBHOOK_URL', message: 'webhookUrl is required' },
      };
    }

    const bodyStr = actionConfig.bodyTemplate
      ? this.templateEngine.interpolate(actionConfig.bodyTemplate, recordData)
      : JSON.stringify(recordData);

    this.logger.log(
      `[Webhook] tenant=${tenantId} ${method} ${url} bodyLength=${bodyStr.length}`,
    );

    try {
      const headers =
        await this.webhookHeaderCrypto.resolveHeadersForExecution(actionConfig);

      const fetchOptions: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        // A single deadline for the whole chain, including redirect hops and a
        // server that stalls the body. The previous manual AbortController was
        // cleared before the error body was read on the failure path.
        signal: AbortSignal.timeout(HTTP_HARD_TIMEOUT_MS),
      };
      if (method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = bodyStr;
      }

      // safeFetch owns SSRF validation and DNS pinning for the initial URL AND
      // for every redirect hop — a public host cannot bounce us to the metadata
      // service. It never sets `redirect: 'follow'`.
      const response = await this.ssrfGuard.safeFetch(url, fetchOptions);

      if (!response.ok) {
        const responseBody = await readResponseCapped(response).catch(
          () => '(unreadable)',
        );
        return {
          success: false,
          error: {
            code: 'WEBHOOK_HTTP_ERROR',
            message: `HTTP ${response.status} ${response.statusText}: ${responseBody.substring(0, 200)}`,
          },
        };
      }

      // Release the TCP connection rather than leaving the body unread.
      await response.body?.cancel().catch(() => {});
      return {
        success: true,
        output: {
          status: response.status,
          statusText: response.statusText,
          url,
          method,
        },
      };
    } catch (error: any) {
      return classifyHttpError(error, url, this.logger, 'WEBHOOK_TIMEOUT');
    }
  }
}

// HTTP Request — call an endpoint and optionally map the response back

@Injectable()
export class HttpRequestExecutor implements ActionExecutor {
  readonly actionType = 'http_request';
  private readonly logger = new Logger(HttpRequestExecutor.name);

  constructor(
    private readonly templateEngine: TemplateInterpolationService,
    private readonly ssrfGuard: SsrfGuardService,
    private readonly crmUpdate: CrmRecordUpdateService,
  ) {}

  async execute(job: AutomationActionJobData): Promise<ActionExecutionResult> {
    const { actionConfig, recordData, tenantId } = job;
    const url = actionConfig.url;
    const method = (actionConfig.method ?? 'GET').toUpperCase();

    if (!url) {
      return {
        success: false,
        retryable: false,
        error: { code: 'NO_URL', message: 'url is required for http_request' },
      };
    }

    const userHeaders: Record<string, string> = {};
    if (Array.isArray(actionConfig.headers)) {
      for (const h of actionConfig.headers) {
        if (h?.key && h?.value) {
          userHeaders[h.key] = this.templateEngine.interpolate(
            h.value,
            recordData,
          );
        }
      }
    }

    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : actionConfig.bodyTemplate
          ? this.templateEngine.interpolate(
              actionConfig.bodyTemplate,
              recordData,
            )
          : JSON.stringify(recordData);

    this.logger.log(
      `[HttpRequest] tenant=${tenantId} ${method} ${url} bodyLength=${body?.length ?? 0}`,
    );

    try {
      const response = await this.ssrfGuard.safeFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...userHeaders },
        body,
        signal: AbortSignal.timeout(HTTP_HARD_TIMEOUT_MS),
      });

      const responseBody = await readResponseCapped(response);

      if (!response.ok) {
        return {
          success: false,
          error: {
            code: 'HTTP_ERROR',
            message: `HTTP ${response.status} ${response.statusText}: ${responseBody.substring(0, 200)}`,
          },
        };
      }

      const mapped = await this.applyResponseMapping(
        actionConfig.responseMapping,
        responseBody,
        job,
      );

      return {
        success: true,
        output: {
          status: response.status,
          url,
          method,
          responseMapped: Object.keys(mapped).length > 0,
          ...mapped,
        },
      };
    } catch (error: any) {
      return classifyHttpError(error, url, this.logger, 'HTTP_TIMEOUT');
    }
  }

  /**
   * Apply response mapping: parse the JSON response, extract values at
   * dot-paths, write them back through the CRM update path.
   *
   * Format: `response.path → recordField`, one mapping per line.
   */
  private async applyResponseMapping(
    mappingStr: string | undefined,
    responseBody: string,
    job: AutomationActionJobData,
  ): Promise<Record<string, any>> {
    if (!mappingStr || !responseBody) return {};

    const result: Record<string, any> = {};
    try {
      const responseJson = JSON.parse(responseBody);
      const lines = mappingStr
        .split('\n')
        .filter((l) => l.includes('→') || l.includes('->'));

      for (const line of lines) {
        const [srcPath, targetField] = line.split(/→|->/).map((s) => s.trim());
        if (!srcPath || !targetField) continue;

        const value = getNestedValue(responseJson, srcPath);
        if (value === undefined) continue;

        await this.crmUpdate.updateField({
          tenantId: job.tenantId,
          recordType: job.recordType,
          recordId: job.recordId,
          field: targetField,
          value,
          sourceWorkflowId: job.sourceWorkflowId,
          automationDepth: job.automationDepth,
          automationBreadcrumbs: job.automationBreadcrumbs,
        });
        result[targetField] = value;
      }
    } catch (err: any) {
      this.logger.warn(`[HttpRequest] Response mapping error: ${err.message}`);
    }
    return result;
  }
}
