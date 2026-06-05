import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'fs';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { once } from 'events';
import { ulid } from 'ulid';
import { ClsService } from 'nestjs-cls';
import { PassThrough, Writable } from 'stream';
import { createGzip } from 'zlib';
import { AllConfigType } from '../../config/config.type';

interface LocalExportToken {
  filePath: string;
  filename: string;
  expiresAt: Date;
  ownerId?: string;
}

/**
 * A streaming destination for an export. The engine writes rows into `writable`
 * (honoring backpressure) and calls `finalize()` once, which flushes/uploads and
 * returns the download descriptor.
 */
export interface ExportSink {
  /** Head of the write pipeline. The engine writes encoded text here. */
  writable: Writable;
  /** End the stream, await upload/flush, and return the download descriptor. */
  finalize: () => Promise<{
    downloadUrl: string;
    expiresAt: string;
    storageKey: string;
  }>;
  /** Abort and clean up on error/cancel. */
  abort: () => Promise<void>;
}

// Download tokens we hand out for local mode are bare ULIDs.
const SAFE_TOKEN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Generic dual-mode (S3 / local-disk) storage for export files.
 *
 * In S3 mode the export streams straight to S3 via `@aws-sdk/lib-storage`
 * (multipart) — NO temp file touches local disk. In local mode it streams to a
 * temp file served back through `/export-download/:token`.
 *
 * Parameterized by `entityPrefix` so each module gets its own namespace
 * (`exports/contacts`, `exports/accounts`, …). Created via ExportStorageFactory.
 */
export class ExportStorageService {
  private readonly localTokens = new Map<string, LocalExportToken>();
  private readonly s3: S3Client | null;
  private readonly prefix: string;

  constructor(
    private readonly entityPrefix: string,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
  ) {
    this.prefix = `exports/${entityPrefix}`;

    const region = this.configService.get('file.awsS3Region', { infer: true });
    const accessKeyId = this.configService.get('file.accessKeyId', {
      infer: true,
    });
    const secretAccessKey = this.configService.get('file.secretAccessKey', {
      infer: true,
    });

    this.s3 =
      region && accessKeyId && secretAccessKey
        ? new S3Client({
            region,
            credentials: { accessKeyId, secretAccessKey },
          })
        : null;
  }

  private bucket(): string | undefined {
    return this.configService.get('file.awsDefaultS3Bucket', { infer: true });
  }

  private sanitizeName(name: string): string {
    return (
      basename(name)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 80) || 'export'
    );
  }

  private localDir(): string {
    return join(process.cwd(), 'files', 'exports', this.entityPrefix);
  }

  /**
   * Open a streaming sink. The engine writes encoded bytes to `sink.writable`
   * and calls `sink.finalize()` exactly once.
   */
  async openSink(
    filename: string,
    opts: {
      contentType: string;
      gzip?: boolean;
      ttlSeconds: number;
    },
  ): Promise<ExportSink> {
    const safeName = this.sanitizeName(filename);
    const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
    const bucket = this.bucket();

    // ── S3 mode: stream straight to S3 via multipart, no local temp ──
    if (this.s3 && bucket) {
      const storageKey = `${this.prefix}/${ulid()}-${safeName}`;
      const passThrough = new PassThrough();
      // When gzipping, the engine writes into the gzip transform which pipes
      // into the S3 body stream. Otherwise it writes straight to the body.
      const gzip = opts.gzip ? createGzip() : null;
      if (gzip) gzip.pipe(passThrough);
      const head: Writable = gzip ?? passThrough;
      const upload = new Upload({
        client: this.s3,
        params: {
          Bucket: bucket,
          Key: storageKey,
          Body: passThrough,
          ContentType: opts.contentType,
          ContentDisposition: `attachment; filename="${safeName}"`,
        },
      });
      const uploadPromise = upload.done();

      return {
        writable: head,
        finalize: async () => {
          // The format writer ends `head`; we only await the upload landing.
          await uploadPromise;
          const downloadUrl = await getSignedUrl(
            this.s3!,
            new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
            { expiresIn: opts.ttlSeconds },
          );
          return {
            downloadUrl,
            expiresAt: expiresAt.toISOString(),
            storageKey,
          };
        },
        abort: async () => {
          passThrough.destroy();
          try {
            await upload.abort();
          } catch {
            // best-effort
          }
        },
      };
    }

    // ── Local mode: stream to a temp file served via download token ──
    const token = ulid();
    const dir = this.localDir();
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${token}.dat`);
    const metadataPath = join(dir, `${token}.json`);
    const out = createWriteStream(filePath, { encoding: 'utf8' });
    const gzip = opts.gzip ? createGzip() : null;
    if (gzip) gzip.pipe(out);
    const head: Writable = gzip ?? out;
    // Register the completion listener NOW so it can't miss the 'finish' event
    // that fires after the format writer ends the stream.
    const finished = once(out, 'finish');

    return {
      writable: head,
      finalize: async () => {
        // The format writer ends `head`; we only await the file flushing.
        await finished;
        const metadata = {
          filePath,
          filename: safeName,
          expiresAt: expiresAt.toISOString(),
          ownerId: this.cls.get('userId'),
        };
        await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
        this.localTokens.set(token, {
          filePath,
          filename: safeName,
          expiresAt,
          ownerId: this.cls.get('userId'),
        });
        return {
          downloadUrl: `/api/v1/${this.entityPrefix}/export-download/${token}`,
          expiresAt: expiresAt.toISOString(),
          storageKey: token,
        };
      },
      abort: async () => {
        head.destroy();
        out.destroy();
        await this.safeUnlink(filePath);
        await this.safeUnlink(metadataPath);
      },
    };
  }

  /** Read a local-mode export file by token, enforcing owner + expiry. */
  async readLocalExport(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    let entry = this.localTokens.get(token);
    if (!entry) {
      entry = (await this.readLocalMetadata(token)) ?? undefined;
      if (entry) this.localTokens.set(token, entry);
    }
    if (!entry) {
      throw new NotFoundException('Export link not found or expired');
    }
    if (entry.expiresAt.getTime() < Date.now()) {
      this.localTokens.delete(token);
      throw new NotFoundException('Export link expired');
    }

    const userId = this.cls.get('userId');
    if (entry.ownerId && userId && entry.ownerId !== userId) {
      throw new ForbiddenException('Export link belongs to another user');
    }

    return {
      buffer: await readFile(entry.filePath),
      filename: entry.filename,
    };
  }

  private async readLocalMetadata(
    token: string,
  ): Promise<LocalExportToken | null> {
    if (!SAFE_TOKEN.test(token)) return null;
    try {
      const raw = await readFile(
        join(this.localDir(), `${token}.json`),
        'utf8',
      );
      const metadata = JSON.parse(raw) as {
        filePath?: string;
        filename?: string;
        expiresAt?: string;
        ownerId?: string;
      };
      if (!metadata.filePath || !metadata.filename || !metadata.expiresAt) {
        return null;
      }
      return {
        filePath: metadata.filePath,
        filename: metadata.filename,
        expiresAt: new Date(metadata.expiresAt),
        ownerId: metadata.ownerId,
      };
    } catch {
      return null;
    }
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // already gone
    }
  }
}

/**
 * Factory for module-specific ExportStorageService instances.
 * Each module gets its own storage namespace.
 */
@Injectable()
export class ExportStorageFactory {
  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
  ) {}

  create(entityPrefix: string): ExportStorageService {
    return new ExportStorageService(entityPrefix, this.configService, this.cls);
  }
}
