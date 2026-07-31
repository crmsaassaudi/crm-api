import {
  ClassSerializerInterceptor,
  INestApplication,
  Logger,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { useContainer } from 'class-validator';
import validationOptions from './utils/validation-options';
import { AllConfigType } from './config/config.type';
import { ResolvePromisesInterceptor } from './utils/serializer.interceptor';
import { NormalizeIdInterceptor } from './common/interceptors/normalize-id.interceptor';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { ClsService } from 'nestjs-cls';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { TENANT_HEADER } from './common/tenant/tenant-header.policy';

/**
 * Reports what the process is still waiting on while bootstrap is unfinished.
 *
 * A boot that stalls inside `NestFactory.create()` (an async module factory that
 * never settles) produces no output at all: Nest logs each module as it finishes,
 * so the *missing* line is the evidence, and the container just sits there
 * answering nothing. This turns that silence into a periodic report naming the
 * pending resource types.
 */
/**
 * Groups the process's open sockets by destination.
 *
 * Resource *types* alone ("TCPSocketWrapx53") do not say which dependency is not
 * answering. The destination port does: 27017 is Mongo, 6379 Redis, 8080/443 the
 * IdP. Uses the internal handle list — guarded, and diagnostics only.
 */
function summarizePendingSockets(): string {
  try {
    const handles =
      (
        process as unknown as {
          _getActiveHandles?: () => unknown[];
        }
      )._getActiveHandles?.() ?? [];

    const counts = new Map<string, number>();
    for (const handle of handles) {
      const socket = handle as {
        remoteAddress?: string;
        remotePort?: number;
        connecting?: boolean;
        readyState?: string;
        _host?: string;
      };
      if (socket.remotePort === undefined && socket._host === undefined)
        continue;

      const target =
        socket.remoteAddress !== undefined && socket.remotePort !== undefined
          ? `${socket.remoteAddress}:${socket.remotePort}`
          : `${socket._host ?? 'unknown'}:?`;
      const state = socket.connecting
        ? 'connecting'
        : (socket.readyState ?? 'unknown');
      const key = `${target}(${state})`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    if (counts.size === 0) return 'none';
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}x${count}`)
      .join(', ');
  } catch (error) {
    return `unavailable (${error instanceof Error ? error.message : 'unknown'})`;
  }
}

function startBootstrapWatchdog(): () => void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    // getActiveResourcesInfo(): e.g. ["TCPSocketWrap", "DNSChannel", "Timeout"]
    const resources =
      (
        process as unknown as { getActiveResourcesInfo?: () => string[] }
      ).getActiveResourcesInfo?.() ?? [];
    const counts = resources.reduce<Record<string, number>>((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});
    Logger.warn(
      `Still starting after ${elapsedSec}s — pending resources: ` +
        (Object.entries(counts)
          .map(([name, count]) => `${name}x${count}`)
          .join(', ') || 'none') +
        ` | sockets: ${summarizePendingSockets()}`,
      'Bootstrap',
    );
  }, 15_000);
  // Never let the watchdog itself keep the process alive.
  timer.unref();
  return () => clearInterval(timer);
}

async function bootstrap() {
  const stopWatchdog = startBootstrapWatchdog();

  const { initSentryIfConfigured } = await import(
    './common/observability/sentry.bootstrap'
  );
  await initSentryIfConfigured();

  Logger.log('Creating Nest application...', 'Bootstrap');
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  Logger.log('Nest application created', 'Bootstrap');
  app.set('trust proxy', 1);

  const configService = app.get(ConfigService<AllConfigType>);
  const isProduction = process.env.NODE_ENV === 'production';

  // Phase logging: everything between "dependencies initialized" and
  // "is running on port" used to be silent, so a stall here was indistinguishable
  // from a crash — the container just sat there answering nothing.
  Logger.log('Connecting Socket.IO Redis adapter...', 'Bootstrap');
  await setupWebSocket(app);
  Logger.log('Socket.IO Redis adapter ready', 'Bootstrap');

  setupSecurityHeaders(app);
  setupWidgetCors(app);
  setupGlobalCors(app, configService, isProduction);
  setupGlobalMiddleware(app, AppModule);
  setupGlobalFiltersAndInterceptors(app);
  setupSwagger(app, configService, isProduction);
  Logger.log('HTTP pipeline configured, starting listener...', 'Bootstrap');

  if (isProduction) {
    runProductionGuards();
  }

  const port = configService.getOrThrow('app.port', { infer: true });
  await app.listen(port);
  stopWatchdog();
  Logger.log(`🚀 CRM API is running on port ${port}`, 'Bootstrap');
}

async function setupWebSocket(app: NestExpressApplication) {
  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);
}

function setupSecurityHeaders(app: INestApplication) {
  const helmetMiddleware = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'wss:', 'https:'],
        fontSrc: ["'self'", 'https:', 'data:'],
        frameSrc: ["'self'"],
      },
    },
  });
  app.use((req: any, res: any, next: any) => {
    // Widget/preview routes embed third-party content; skip CSP for them
    if (req.url?.includes('/livechat/preview/')) {
      return next();
    }
    return helmetMiddleware(req, res, next);
  });
}

function setupWidgetCors(app: INestApplication) {
  app.use((req: any, res: any, next: any) => {
    const url: string = req.url || '';
    const isWidgetRoute =
      url.includes('/csat/submit/') ||
      url.includes('/livechat/config/') ||
      url.includes('/livechat/history/') ||
      url.includes('/livechat/analytics/') ||
      url.includes('/livechat/embed/');
    if (isWidgetRoute) {
      const origin = req.headers?.origin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
    }
    return next();
  });
}

function setupGlobalCors(
  app: INestApplication,
  configService: ConfigService<AllConfigType>,
  isProduction: boolean,
) {
  const frontendDomain = configService.get('app.frontendDomain', {
    infer: true,
  });
  const rootDomain = configService.get('app.rootDomain', { infer: true });

  const allowedFrontendOrigins =
    isProduction && frontendDomain
      ? frontendDomain
          .split(',')
          .map((d) => d.trim())
          .filter(Boolean)
      : null;

  const normalizedRootDomain = rootDomain?.trim().toLowerCase() || null;

  // Multi-tenant: every tenant is served at its own subdomain of the root
  // domain (e.g. master.crmsaudi.dev), so all subdomains of app.rootDomain
  // must pass CORS — not just the single FRONTEND_DOMAIN entry.
  const isAllowedOrigin = (origin: string): boolean => {
    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (
      normalizedRootDomain &&
      (host === normalizedRootDomain ||
        host.endsWith(`.${normalizedRootDomain}`))
    ) {
      return true;
    }
    // Explicit allowlist — exact origin match (no loose substring check).
    return Boolean(allowedFrontendOrigins?.includes(origin));
  };

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean | string) => void,
    ) => {
      if (!origin || !isProduction) return callback(null, true);
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      // SECURITY: Reject non-allowlisted origins in production
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Idempotency-Key',
      'x-custom-lang',
      // The constant, not the literal: this is a tenant-resolution input, and its name
      // living in three files is how one of them gets missed.
      TENANT_HEADER,
    ],
  });
}

function setupGlobalMiddleware(app: INestApplication, AppModule: any) {
  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  app.use(cookieParser());
  app.use(
    json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.enableShutdownHooks();
  const configService = app.get(ConfigService<AllConfigType>);
  app.setGlobalPrefix(
    configService.getOrThrow('app.apiPrefix', { infer: true }),
    {
      exclude: ['/', '/queues'],
    },
  );
  app.enableVersioning({ type: VersioningType.URI });
}

function setupGlobalFiltersAndInterceptors(app: INestApplication) {
  const httpAdapter = app.get(HttpAdapterHost);
  const clsService = app.get(ClsService);
  const reflector = app.get(Reflector);

  app.useGlobalFilters(new GlobalExceptionFilter(httpAdapter, clsService));
  app.useGlobalPipes(new ValidationPipe(validationOptions));
  app.useGlobalInterceptors(
    new CorrelationIdInterceptor(clsService),
    new NormalizeIdInterceptor(),
    new ResolvePromisesInterceptor(),
    new ClassSerializerInterceptor(reflector),
  );
}

function setupSwagger(
  app: INestApplication,
  configService: ConfigService<AllConfigType>,
  isProduction: boolean,
) {
  if (!isProduction) {
    const options = new DocumentBuilder()
      .setTitle('API')
      .setDescription('API docs')
      .setVersion('1.0')
      .addBearerAuth()
      .addGlobalParameters({
        in: 'header',
        required: false,
        name: process.env.APP_HEADER_LANGUAGE ?? 'x-custom-lang',
        schema: { example: 'en' },
      })
      .build();
    const document = SwaggerModule.createDocument(app, options);
    SwaggerModule.setup('docs', app, document);
    Logger.log(
      `📖 Swagger docs: http://localhost:${configService.getOrThrow('app.port', { infer: true })}/docs`,
      'Bootstrap',
    );
  }
}

function runProductionGuards() {
  const jwtSecret = process.env.AUTH_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret === 'secret') {
    Logger.error(
      '🚫 FATAL: AUTH_JWT_SECRET is not set or insecure.',
      'Bootstrap',
    );
    process.exit(1);
  }

  const refreshSecret = process.env.AUTH_REFRESH_SECRET;
  if (!refreshSecret || refreshSecret.length < 32) {
    Logger.error(
      '🚫 FATAL: AUTH_REFRESH_SECRET is missing or too short.',
      'Bootstrap',
    );
    process.exit(1);
  }

  if (
    (process.env.FILE_DRIVER === 's3' ||
      process.env.FILE_DRIVER === 's3-presigned') &&
    (!process.env.ACCESS_KEY_ID || !process.env.SECRET_ACCESS_KEY)
  ) {
    Logger.error('🚫 FATAL: S3 credentials missing.', 'Bootstrap');
    process.exit(1);
  }

  if (
    !process.env.INTERNAL_API_KEY ||
    process.env.INTERNAL_API_KEY.length < 16
  ) {
    Logger.warn('⚠️  INTERNAL_API_KEY is missing or too short.', 'Bootstrap');
  }

  if (!process.env.REDIS_PASSWORD) {
    Logger.warn('⚠️  REDIS_PASSWORD is empty in production.', 'Bootstrap');
  }

  if (!process.env.FRONTEND_DOMAIN) {
    Logger.warn('⚠️  FRONTEND_DOMAIN is not set.', 'Bootstrap');
  }
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal: failed to start API server', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(
    '[Process] Unhandled Rejection at:',
    promise,
    'reason:',
    reason,
  );
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  process.exit(1);
});
