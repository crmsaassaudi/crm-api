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
import { access, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { ulid } from 'ulid';
import { ClsService } from 'nestjs-cls';
import { AllConfigType } from '../../config/config.type';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

interface LocalFileToken {
  filePath: string;
  filename: string;
  expiresAt: Date;
  ownerId?: string;
}

// Storage keys we generate: <prefix>/<ulid>-<safeName>. Reject anything else
// before touching S3 / disk so a hostile fileKey can't escape the prefix.
const SAFE_KEY_PATTERN =
  /^imports\/[a-z]+\/[0-9A-HJKMNP-TV-Z]{26}-[A-Za-z0-9._-]{1,80}$/;

/**
 * Generic dual-mode (S3 / local-disk) storage for import files and reports.
 *
 * Parameterized by `entityPrefix` so each module gets its own storage
 * namespace (e.g. `contacts`, `accounts`, `deals`, `tickets`).
 *
 * This service is NOT a NestJS Injectable — each module creates its own
 * instance via the ImportStorageFactory.
 */
export class ImportStorageService {
  private readonly localReportTokens = new Map<string, LocalFileToken>();
  private readonly s3: S3Client | null;
  private readonly importPrefix: string;
  private readonly reportPrefix: string;

  constructor(
    private readonly entityPrefix: string,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
  ) {
    this.importPrefix = `imports/${entityPrefix}`;
    this.reportPrefix = `imports/${entityPrefix}-reports`;

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

  private isS3Enabled(): boolean {
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });
    return Boolean(this.s3 && bucket);
  }

  private localPathForKey(fileKey: string): string {
    return join(process.cwd(), 'files', ...fileKey.split('/'));
  }

  private assertSafeKey(fileKey: string): void {
    if (
      !SAFE_KEY_PATTERN.test(fileKey) ||
      !fileKey.startsWith(`${this.importPrefix}/`)
    ) {
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

  // FILE UPLOAD

  async storeImportFile(file: {
    buffer: Buffer;
    originalname: string;
  }): Promise<{ fileKey: string }> {
    const fileKey = `${this.importPrefix}/${ulid()}-${this.sanitizeName(
      file.originalname,
    )}`;
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });
    const ownerId = this.cls.get('userId') ?? this.cls.get('user.id');
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!ownerId || !tenantId) {
      throw new ForbiddenException('Authenticated tenant context is required');
    }

    if (this.s3 && bucket) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fileKey,
          Body: file.buffer,
          ContentDisposition: `attachment; filename="${this.sanitizeName(
            file.originalname,
          )}"`,
          Metadata: { ownerid: String(ownerId), tenantid: String(tenantId) },
        }),
      );
      return { fileKey };
    }

    const filePath = this.localPathForKey(fileKey);
    await mkdir(join(process.cwd(), 'files', this.importPrefix), {
      recursive: true,
    });
    await writeFile(filePath, file.buffer);
    await writeFile(
      `${filePath}.meta.json`,
      JSON.stringify({ ownerId: String(ownerId), tenantId: String(tenantId) }),
      'utf8',
    );
    return { fileKey };
  }

  async assertImportFileOwnership(
    fileKey: string,
    tenantId: string,
    ownerId: string,
  ): Promise<void> {
    this.assertSafeKey(fileKey);
    const bucket = this.configService.get('file.awsDefaultS3Bucket', {
      infer: true,
    });
    let metadata: { ownerId?: string; tenantId?: string };
    if (this.s3 && bucket) {
      try {
        const head = await this.s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: fileKey }),
        );
        metadata = {
          ownerId: head.Metadata?.ownerid,
          tenantId: head.Metadata?.tenantid,
        };
      } catch {
        throw new NotFoundException('Import file not found');
      }
    } else {
      try {
        metadata = JSON.parse(
          await readFile(`${this.localPathForKey(fileKey)}.meta.json`, 'utf8'),
        );
      } catch {
        throw new NotFoundException('Import file not found');
      }
    }
    if (
      !metadata.ownerId ||
      !metadata.tenantId ||
      String(metadata.ownerId) !== String(ownerId) ||
      String(metadata.tenantId) !== String(tenantId)
    ) {
      throw new ForbiddenException(
        'Import file belongs to another user or tenant',
      );
    }
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
    if (
      !SAFE_KEY_PATTERN.test(fileKey) ||
      !fileKey.startsWith(`${this.importPrefix}/`)
    )
      return;
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
        await unlink(`${this.localPathForKey(fileKey)}.meta.json`).catch(
          () => undefined,
        );
      }
    } catch {
      // Best-effort cleanup — a leftover temp file is reaped by the TTL sweep.
    }
  }

  // REPORT STORAGE

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
      const storageKey = `${this.reportPrefix}/${ulid()}-${safeName}`;
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
    const reportDir = join(process.cwd(), 'files', this.reportPrefix);
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
      reportUrl: `/api/v1/${this.entityPrefix}/import-report/${token}`,
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
    if (entry.ownerId && entry.ownerId !== userId) {
      throw new ForbiddenException('Report link belongs to another user');
    }

    return {
      buffer: await readFile(entry.filePath),
      filename: entry.filename,
    };
  }

  /** Stream a potentially large error report without buffering it in the API. */
  async openLocalReport(token: string): Promise<{
    stream: ReturnType<typeof createReadStream>;
    filename: string;
    size: number;
  }> {
    const entry = await this.resolveOwnedLocalReport(token);
    const fileStat = await stat(entry.filePath);
    return {
      stream: createReadStream(entry.filePath),
      filename: entry.filename,
      size: fileStat.size,
    };
  }

  private async resolveOwnedLocalReport(
    token: string,
  ): Promise<LocalFileToken> {
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
    if (entry.ownerId && entry.ownerId !== this.cls.get('userId')) {
      throw new ForbiddenException('Report link belongs to another user');
    }
    return entry;
  }

  private async readLocalReportMetadata(
    token: string,
  ): Promise<LocalFileToken | null> {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(token)) return null;
    try {
      const reportDir = join(process.cwd(), 'files', this.reportPrefix);
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

/**
 * Factory for creating module-specific ImportStorageService instances.
 * Each module gets its own storage namespace.
 */
@Injectable()
export class ImportStorageFactory {
  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
  ) {}

  create(entityPrefix: string): ImportStorageService {
    return new ImportStorageService(entityPrefix, this.configService, this.cls);
  }
}
