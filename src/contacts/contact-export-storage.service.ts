import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'fs';
import { access, mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { ulid } from 'ulid';
import { ClsService } from 'nestjs-cls';
import { AllConfigType } from '../config/config.type';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

interface LocalExportToken {
  filePath: string;
  filename: string;
  expiresAt: Date;
  ownerId?: string;
}

const IMPORT_PREFIX = 'imports/contacts';
const REPORT_PREFIX = 'imports/reports';
// Storage keys we generate: <prefix>/<ulid>-<safeName>. Reject anything else
// before touching S3 / disk so a hostile fileKey can't escape the prefix.
const SAFE_IMPORT_KEY = /^imports\/(contacts|reports)\/[A-Za-z0-9._-]+$/;

@Injectable()
export class ContactExportStorageService {
  private readonly localTokens = new Map<string, LocalExportToken>();
  private readonly localReportTokens = new Map<string, LocalExportToken>();
  private readonly s3: S3Client | null;

  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
  ) {
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

  async storeCsv(
    csv: string,
    filename: string,
    ttlSeconds = 5 * 60,
  ): Promise<{ downloadUrl: string; expiresAt: string; storageKey: string }> {
    return this.storeCsvStream([csv], filename, ttlSeconds);
  }

  async storeCsvStream(
    rows: AsyncIterable<string> | Iterable<string>,
    filename: string,
    ttlSeconds = 5 * 60,
  ): Promise<{ downloadUrl: string; expiresAt: string; storageKey: string }> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });

    if (this.s3 && bucket) {
      const storageKey = `exports/contacts/${ulid()}-${filename}`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: Readable.from(rows, { encoding: 'utf8' }),
          ContentType: 'text/csv; charset=utf-8',
          ContentDisposition: `attachment; filename="${filename}"`,
        }),
      );
      const downloadUrl = await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
        { expiresIn: ttlSeconds },
      );

      return {
        downloadUrl,
        expiresAt: expiresAt.toISOString(),
        storageKey,
      };
    }

    const storageKey = ulid();
    const exportDir = join(process.cwd(), 'files', 'exports', 'contacts');
    const filePath = join(exportDir, `${storageKey}.csv`);
    const metadataPath = join(exportDir, `${storageKey}.json`);
    await mkdir(exportDir, { recursive: true });
    await pipeline(
      Readable.from(rows, { encoding: 'utf8' }),
      createWriteStream(filePath, { encoding: 'utf8' }),
    );

    const token = storageKey;
    const metadata = {
      filePath,
      filename,
      expiresAt: expiresAt.toISOString(),
      ownerId: this.cls.get('userId'),
    };
    await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
    this.localTokens.set(token, {
      filePath,
      filename,
      expiresAt,
      ownerId: this.cls.get('userId'),
    });

    return {
      downloadUrl: `/api/v1/contacts/export-download/${token}`,
      expiresAt: expiresAt.toISOString(),
      storageKey,
    };
  }

  async readLocalExport(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    let entry: LocalExportToken | null | undefined =
      this.localTokens.get(token);
    if (!entry) {
      entry = await this.readLocalMetadata(token);
      if (entry) {
        this.localTokens.set(token, entry);
      }
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
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(token)) {
      return null;
    }

    try {
      const exportDir = join(process.cwd(), 'files', 'exports', 'contacts');
      const raw = await readFile(join(exportDir, `${token}.json`), 'utf8');
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

  // ─────────────────────────── IMPORT SUPPORT ───────────────────────────
  //
  // The import pipeline reuses this dual-mode (S3 / local-disk) storage:
  //   1. Upload — `storeImportFile` persists the raw .csv/.xlsx, returns a key.
  //   2. Worker — `openImportStream` streams it back without buffering.
  //   3. Report — `storeReportStream` writes the JSON error report; the local
  //      variant is downloadable via `/v1/contacts/import-report/:token`.
  //
  // `fileKey` is the S3 object key in cloud mode; in local mode it is the same
  // logical key, resolved to `files/<key>` on disk. Whether a deployment is S3
  // or local is fixed per environment, so the worker resolves it identically
  // to the uploader.

  private isS3Enabled(): boolean {
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });
    return Boolean(this.s3 && bucket);
  }

  private localPathForKey(fileKey: string): string {
    // fileKey is validated against SAFE_IMPORT_KEY (no slashes beyond the
    // fixed prefix, no `..`), so this join cannot traverse outside `files/`.
    return join(process.cwd(), 'files', ...fileKey.split('/'));
  }

  private assertSafeKey(fileKey: string): void {
    if (!SAFE_IMPORT_KEY.test(fileKey)) {
      throw new NotFoundException('Import file not found');
    }
  }

  private sanitizeName(name: string): string {
    return (
      basename(name)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 80) || 'import'
    );
  }

  async storeImportFile(file: {
    buffer: Buffer;
    originalname: string;
  }): Promise<{ fileKey: string }> {
    const fileKey = `${IMPORT_PREFIX}/${ulid()}-${this.sanitizeName(
      file.originalname,
    )}`;
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });

    if (this.s3 && bucket) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fileKey,
          Body: file.buffer,
          ContentDisposition: `attachment; filename="${this.sanitizeName(
            file.originalname,
          )}"`,
        }),
      );
      return { fileKey };
    }

    const filePath = this.localPathForKey(fileKey);
    await mkdir(join(process.cwd(), 'files', IMPORT_PREFIX), {
      recursive: true,
    });
    await writeFile(filePath, file.buffer);
    return { fileKey };
  }

  async importFileExists(fileKey: string): Promise<boolean> {
    this.assertSafeKey(fileKey);
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });

    if (this.s3 && bucket) {
      try {
        await this.s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: fileKey }),
        );
        return true;
      } catch {
        return false;
      }
    }

    try {
      await access(this.localPathForKey(fileKey));
      return true;
    } catch {
      return false;
    }
  }

  async openImportStream(fileKey: string): Promise<Readable> {
    this.assertSafeKey(fileKey);
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });

    if (this.s3 && bucket) {
      const res = await this.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: fileKey }),
      );
      const body = res.Body;
      if (!body || !(body instanceof Readable)) {
        throw new NotFoundException('Import file not found');
      }
      return body;
    }

    return createReadStream(this.localPathForKey(fileKey));
  }

  async deleteImportFile(fileKey: string): Promise<void> {
    if (!SAFE_IMPORT_KEY.test(fileKey)) return;
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });
    try {
      if (this.s3 && bucket) {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: fileKey }),
        );
      } else {
        await unlink(this.localPathForKey(fileKey));
      }
    } catch {
      // Best-effort cleanup — a leftover temp file is reaped by the TTL sweep.
    }
  }

  /**
   * Persist the JSON error report by streaming it (never holding the full
   * report in memory). Returns a download URL valid for `ttlSeconds`.
   */
  async storeReportStream(
    body: Readable,
    filename: string,
    ttlSeconds = 24 * 60 * 60,
  ): Promise<{ reportUrl: string; expiresAt: string; storageKey: string }> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const safeName = this.sanitizeName(filename);
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });

    if (this.s3 && bucket) {
      const storageKey = `${REPORT_PREFIX}/${ulid()}-${safeName}`;
      await this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: body,
          ContentType: 'application/json; charset=utf-8',
          ContentDisposition: `attachment; filename="${safeName}"`,
        }),
      );
      const reportUrl = await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
        { expiresIn: ttlSeconds },
      );
      return { reportUrl, expiresAt: expiresAt.toISOString(), storageKey };
    }

    const token = ulid();
    const reportDir = join(process.cwd(), 'files', REPORT_PREFIX);
    const filePath = join(reportDir, `${token}.json`);
    const metadataPath = join(reportDir, `${token}.meta.json`);
    await mkdir(reportDir, { recursive: true });
    await pipeline(body, createWriteStream(filePath, { encoding: 'utf8' }));

    const metadata = {
      filePath,
      filename: safeName,
      expiresAt: expiresAt.toISOString(),
      ownerId: this.cls.get('userId'),
    };
    await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
    this.localReportTokens.set(token, {
      filePath,
      filename: safeName,
      expiresAt,
      ownerId: this.cls.get('userId'),
    });

    return {
      reportUrl: `/api/v1/contacts/import-report/${token}`,
      expiresAt: expiresAt.toISOString(),
      storageKey: token,
    };
  }

  async readLocalReport(
    token: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    let entry = this.localReportTokens.get(token);
    if (!entry) {
      entry = (await this.readLocalReportMetadata(token)) ?? undefined;
      if (entry) this.localReportTokens.set(token, entry);
    }
    if (!entry) {
      throw new NotFoundException('Report link not found or expired');
    }
    if (entry.expiresAt.getTime() < Date.now()) {
      this.localReportTokens.delete(token);
      throw new NotFoundException('Report link expired');
    }

    const userId = this.cls.get('userId');
    if (entry.ownerId && userId && entry.ownerId !== userId) {
      throw new ForbiddenException('Report link belongs to another user');
    }

    return {
      buffer: await readFile(entry.filePath),
      filename: entry.filename,
    };
  }

  private async readLocalReportMetadata(
    token: string,
  ): Promise<LocalExportToken | null> {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(token)) return null;
    try {
      const reportDir = join(process.cwd(), 'files', REPORT_PREFIX);
      const raw = await readFile(join(reportDir, `${token}.meta.json`), 'utf8');
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
}
