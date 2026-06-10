import {
  HttpStatus,
  Injectable,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { FileRepository } from '../../persistence/file.repository';

import { FileUploadDto } from './dto/file.dto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomStringGenerator } from '@nestjs/common/utils/random-string-generator.util';
import { ConfigService } from '@nestjs/config';
import { FileType } from '../../../domain/file';
import { AllConfigType } from '../../../../config/config.type';
import {
  isAllowedImageFileName,
  isAllowedImageMimeType,
} from '../../../file-upload-security.util';

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

@Injectable()
export class FilesS3PresignedService {
  private s3: S3Client;

  constructor(
    private readonly fileRepository: FileRepository,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly cls: ClsService,
  ) {
    this.s3 = new S3Client({
      region: configService.get('file.awsS3Region', { infer: true }),
      endpoint:
        configService.get('file.awsS3Endpoint', { infer: true }) || undefined,
      forcePathStyle: !!configService.get('file.awsS3Endpoint', {
        infer: true,
      }),
      credentials: {
        accessKeyId: configService.getOrThrow('file.accessKeyId', {
          infer: true,
        }),
        secretAccessKey: configService.getOrThrow('file.secretAccessKey', {
          infer: true,
        }),
      },
      // Retry transient S3 errors instead of failing the upload outright.
      maxAttempts: 3,
    });
  }

  async create(
    file: FileUploadDto,
  ): Promise<{ file: FileType; uploadSignedUrl: string }> {
    if (!file) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          file: 'selectFile',
        },
      });
    }

    if (
      !isAllowedImageFileName(file.fileName) ||
      (file.contentType && !isAllowedImageMimeType(file.contentType))
    ) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          file: `cantUploadFileType`,
        },
      });
    }

    if (
      file.fileSize >
      (this.configService.get('file.maxFileSize', {
        infer: true,
      }) || 0)
    ) {
      throw new PayloadTooLargeException({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        error: 'Payload Too Large',
        message: 'File too large',
      });
    }

    // Key shape: `{tenantId}/{uuid}.{ext}` — never include user-supplied
    // filename in the path. Tenant prefix gives us natural per-tenant
    // bucket policies and prevents cross-tenant key collisions/guessing.
    const tenantId =
      this.cls.get<string>('activeTenantId') ||
      this.cls.get<string>('tenantId') ||
      'platform';
    const ext = (file.fileName.split('.').pop() || '').toLowerCase();
    if (!SAFE_EXT.test(ext)) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: { file: 'invalidExtension' },
      });
    }
    const key = `${tenantId}/${randomStringGenerator()}.${ext}`;

    // Dynamic TTL: small files use a short presigned URL; larger uploads
    // need longer windows because slow uplinks (mobile) can take several
    // minutes to push a 30+ MB attachment.
    const expiresIn = file.fileSize > 10 * 1024 * 1024 ? 7200 : 3600;

    const command = new PutObjectCommand({
      Bucket: this.configService.getOrThrow('file.awsDefaultS3Bucket', {
        infer: true,
      }),
      Key: key,
      ContentLength: file.fileSize,
      ContentType: file.contentType,
      // Force the browser to download as an attachment using the safe
      // (sanitized) filename — never the raw user-supplied one. This
      // prevents Content-Type override attacks where an attacker uploads
      // image.jpg but reads back as image.exe via a different Content-Type.
      ContentDisposition: `attachment; filename="${sanitizeFilename(file.fileName)}"`,
      // Tag the object with its tenant so a misconfigured bucket policy
      // still has metadata we can scan for compliance.
      Metadata: { tenantId },
    });
    const signedUrl = await getSignedUrl(this.s3, command, { expiresIn });
    const data = await this.fileRepository.create({
      path: key,
    });

    return {
      file: data,
      uploadSignedUrl: signedUrl,
    };
  }
}

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\w.\-]/g, '_')
      .slice(0, 120) || 'file'
  );
}
