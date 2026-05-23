import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
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

@Injectable()
export class ContactExportStorageService {
  private readonly localTokens = new Map<string, LocalExportToken>();
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
    const exportDir = join(process.cwd(), 'tmp', 'exports', 'contacts');
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
      const exportDir = join(process.cwd(), 'tmp', 'exports', 'contacts');
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
}
