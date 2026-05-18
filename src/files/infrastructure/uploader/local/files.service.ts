import {
  HttpStatus,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { open, unlink } from 'fs/promises';

import { FileRepository } from '../../persistence/file.repository';
import { AllConfigType } from '../../../../config/config.type';
import { FileType } from '../../../domain/file';
import { detectAllowedImageMimeFromBuffer } from '../../../file-upload-security.util';

@Injectable()
export class FilesLocalService {
  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    private readonly fileRepository: FileRepository,
  ) {}

  async create(file: Express.Multer.File): Promise<{ file: FileType }> {
    if (!file) {
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          file: 'selectFile',
        },
      });
    }
    await this.assertMagicBytes(file);

    return {
      file: await this.fileRepository.create({
        path: `/${this.configService.get('app.apiPrefix', {
          infer: true,
        })}/v1/${file.path}`,
      }),
    };
  }

  private async assertMagicBytes(file: Express.Multer.File): Promise<void> {
    const handle = await open(file.path, 'r');
    const buffer = Buffer.alloc(12);

    try {
      await handle.read(buffer, 0, buffer.length, 0);
    } finally {
      await handle.close();
    }

    const detectedMime = detectAllowedImageMimeFromBuffer(buffer);
    if (!detectedMime) {
      await unlink(file.path).catch(() => undefined);
      throw new UnprocessableEntityException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        errors: {
          file: 'cantUploadFileType',
        },
      });
    }
  }
}
