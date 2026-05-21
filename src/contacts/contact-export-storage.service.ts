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
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ulid } from 'ulid';
import { ClsService } from 'nestjs-cls';
import { AllConfigType } from '../config/config.type';

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
          Body: Buffer.from(csv, 'utf8'),
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
    await mkdir(exportDir, { recursive: true });
    await writeFile(filePath, csv, 'utf8');

    const token = ulid();
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
    const entry = this.localTokens.get(token);
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
}
