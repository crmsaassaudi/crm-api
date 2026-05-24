import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MongooseModuleOptions,
  MongooseOptionsFactory,
} from '@nestjs/mongoose';
import { AllConfigType } from '../config/config.type';

@Injectable()
export class MongooseConfigService implements MongooseOptionsFactory {
  constructor(private configService: ConfigService<AllConfigType>) {}

  createMongooseOptions(): MongooseModuleOptions {
    const isProd = process.env.NODE_ENV === 'production';

    return {
      uri: this.configService.get('database.url', { infer: true }),
      dbName: this.configService.get('database.name', { infer: true }),
      user: this.configService.get('database.username', { infer: true }),
      pass: this.configService.get('database.password', { infer: true }),

      // ── Atlas Resilience ─────────────────────────────────────────
      // Wait up to 45s for a primary (default 30s is too tight for
      // cross-region Atlas clusters behind Docker DNS).
      serverSelectionTimeoutMS: 45_000,

      // Socket-level timeout — guards against hung connections.
      socketTimeoutMS: 60_000,

      // Faster health checks so the driver detects recovery sooner.
      heartbeatFrequencyMS: 5_000,

      // Automatically retry transient write/read failures.
      retryWrites: true,
      retryReads: true,

      // Connection pooling: keeps warm connections to avoid cold-start
      // latency on traffic spikes.
      maxPoolSize: isProd ? 50 : 10,
      minPoolSize: isProd ? 5 : 2,

      // Only build indexes in dev; in prod they should be managed via
      // migration scripts to avoid unexpected blocking operations.
      autoIndex: !isProd,
    };
  }
}
