import {
  ClassSerializerInterceptor,
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
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { ClsService } from 'nestjs-cls';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';
import helmet from 'helmet';

async function bootstrap() {
  process.env.APP_RUNTIME = 'api';
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

  await app.listen(configService.getOrThrow('app.port', { infer: true }));
}
void bootstrap();
