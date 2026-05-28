import {
  ClassSerializerInterceptor,
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

async function bootstrap() {
  process.env.APP_RUNTIME = 'api';
  // Best-effort Sentry init BEFORE AppModule loads so we capture
  // exceptions thrown during DI bootstrap.
  const { initSentryIfConfigured } = await import(
    './common/observability/sentry.bootstrap'
  );
  await initSentryIfConfigured();
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 1);

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  const configService = app.get(ConfigService<AllConfigType>);

  // Security headers — must be before any route registration
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  const frontendDomain = configService.get('app.frontendDomain', {
    infer: true,
  });
  const isProduction = process.env.NODE_ENV === 'production';
  // In production, FRONTEND_DOMAIN must be set. Falling back to wildcard true
  // is a security risk (cross-tenant data leakage).
  const corsOrigin = isProduction
    ? frontendDomain
      ? frontendDomain.split(',').map((d) => d.trim())
      : false // deny all cross-origin in production if FRONTEND_DOMAIN is unset
    : true; // dev: allow any origin for dynamic tenant subdomains
  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Idempotency-Key',
      'x-custom-lang',
      'x-tenant-id',
    ],
  });

  // Enable cookie parsing for HttpOnly session cookies (BFF pattern)
  app.use(cookieParser());

  // Capture rawBody for webhook signature verification. Adapters
  // (Facebook/WhatsApp/Zalo) HMAC the exact bytes the provider sent — JSON
  // re-serialization would change whitespace/key order and invalidate the
  // signature. Without this, a stripped signature check could silently
  // succeed on attacker-controlled payloads.
  app.use(
    json({
      limit: '10mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  // Use Winston Logger
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  // Global Exception Filter
  const httpAdapter = app.get(HttpAdapterHost);
  const clsService = app.get(ClsService);
  app.useGlobalFilters(new GlobalExceptionFilter(httpAdapter, clsService));

  app.enableShutdownHooks();
  app.setGlobalPrefix(
    configService.getOrThrow('app.apiPrefix', { infer: true }),
    {
      exclude: ['/', '/queues'],
    },
  );
  app.enableVersioning({
    type: VersioningType.URI,
  });
  app.useGlobalPipes(new ValidationPipe(validationOptions));
  app.useGlobalInterceptors(
    // CorrelationIdInterceptor must run first so subsequent interceptors,
    // services and the global exception filter see the request ID in CLS.
    new CorrelationIdInterceptor(clsService),
    // ResolvePromisesInterceptor is used to resolve promises in responses because class-transformer can't do it
    // https://github.com/typestack/class-transformer/issues/549
    new NormalizeIdInterceptor(),
    new ResolvePromisesInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );

  const options = new DocumentBuilder()
    .setTitle('API')
    .setDescription('API docs')
    .setVersion('1.0')
    .addBearerAuth()
    .addGlobalParameters({
      in: 'header',
      required: false,
      name: process.env.APP_HEADER_LANGUAGE || 'x-custom-lang',
      schema: {
        example: 'en',
      },
    })
    .build();

  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('docs', app, document);

  // ── Production Startup Guards ──────────────────────────────────
  if (isProduction) {
    const jwtSecret = process.env.AUTH_JWT_SECRET || process.env.JWT_SECRET;
    if (!jwtSecret || jwtSecret === 'secret') {
      Logger.error(
        '🚫 FATAL: AUTH_JWT_SECRET is not set or is using the insecure default "secret". ' +
          'Set a cryptographically random 256-bit secret before deploying to production.',
        'Bootstrap',
      );
      process.exit(1);
    }

    if (!process.env.REDIS_PASSWORD) {
      Logger.warn(
        '⚠️  REDIS_PASSWORD is empty in production — Redis is accessible without authentication!',
        'Bootstrap',
      );
    }

    if (!process.env.FRONTEND_DOMAIN) {
      Logger.warn(
        '⚠️  FRONTEND_DOMAIN is not set — CORS will deny ALL cross-origin requests in production.',
        'Bootstrap',
      );
    }
  }

  await app.listen(configService.getOrThrow('app.port', { infer: true }));

  const port = configService.getOrThrow('app.port', { infer: true });
  Logger.log(`🚀 CRM API is running on port ${port}`, 'Bootstrap');
  Logger.log(`📖 Swagger docs: http://localhost:${port}/docs`, 'Bootstrap');
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal: failed to start API server', err);
  process.exit(1);
});

// Catch unhandled promise rejections that escape NestJS error boundaries
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Catch synchronous exceptions thrown outside of async context
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
  process.exit(1);
});
