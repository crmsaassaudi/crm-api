import {
  utilities as nestWinstonUtilities,
  WinstonModuleOptions,
} from 'nest-winston';
import * as winston from 'winston';
import { ClsService } from 'nestjs-cls';
import { maskSecrets } from './secret-masker';

// Winston `format` that walks the log meta and message and strips anything
// that looks like a credential. Applied for every transport before any
// formatter that serializes to string.
const maskFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = maskSecrets(info.message);
  } else if (info.message && typeof info.message === 'object') {
    info.message = maskSecrets(info.message);
  }
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message' || key === 'timestamp') continue;
    info[key] = maskSecrets((info as any)[key]);
  }
  return info;
})();

/**
 * Decide log format from env. Production observability stacks (Loki,
 * CloudWatch, Datadog) ingest JSON cleanly; humans tailing dev consoles
 * prefer the colorized nest-like format.
 *
 * LOG_FORMAT=json   — JSON lines (default in production)
 * LOG_FORMAT=pretty — colorized nest-like format (default elsewhere)
 */
function shouldUseJsonFormat(): boolean {
  const raw = process.env.LOG_FORMAT?.toLowerCase().trim();
  if (raw === 'json') return true;
  if (raw === 'pretty' || raw === 'text' || raw === 'nestlike') return false;
  return process.env.NODE_ENV === 'production';
}

function contextFields(clsService: ClsService) {
  return () => {
    let correlationId = 'N/A';
    let tenantId = '-';
    let userId = '-';
    try {
      correlationId =
        (clsService.get && clsService.get<string>('correlationId')) ||
        clsService.getId?.() ||
        'N/A';
      tenantId =
        (clsService.get && clsService.get<string>('tenantId')) || '-';
      userId = (clsService.get && clsService.get<string>('userId')) || '-';
    } catch {
      /* CLS not bound (e.g. boot-time logs) — leave defaults */
    }
    return { correlationId, tenantId, userId };
  };
}

export const winstonConfig = (clsService: ClsService): WinstonModuleOptions => {
  const getContext = contextFields(clsService);
  const useJson = shouldUseJsonFormat();

  const jsonFormat = winston.format.combine(
    maskFormat,
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format((info) => {
      const ctx = getContext();
      info.correlationId = ctx.correlationId;
      info.tenantId = ctx.tenantId;
      info.userId = ctx.userId;
      info.service = process.env.APP_RUNTIME || 'api';
      return info;
    })(),
    winston.format.json(),
  );

  const prettyFormat = winston.format.combine(
    maskFormat,
    winston.format.timestamp(),
    winston.format.ms(),
    nestWinstonUtilities.format.nestLike('MyApp', {
      colors: true,
      prettyPrint: true,
    }),
    winston.format.printf(
      ({ context, level, timestamp, message, ms, ...meta }) => {
        const ctx = getContext();
        const metaString = Object.keys(meta).length
          ? JSON.stringify(meta)
          : '';
        return `[${timestamp}] [${ctx.correlationId}] [tenant=${ctx.tenantId} user=${ctx.userId}] ${level} [${context}] : ${message} ${ms} ${metaString}`;
      },
    ),
  );

  return {
    transports: [
      new winston.transports.Console({
        format: useJson ? jsonFormat : prettyFormat,
      }),
      // Add File transport if needed, e.g.:
      // new winston.transports.File({ filename: 'error.log', level: 'error' }),
      // new winston.transports.File({ filename: 'combined.log' }),
    ],
  };
};
