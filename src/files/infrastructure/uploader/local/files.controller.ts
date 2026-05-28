import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Response,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import * as path from 'path';
import { FilesLocalService } from './files.service';
import { FileResponseDto } from './dto/file-response.dto';

const FILES_ROOT = path.resolve(process.cwd(), 'files');
// Only allow filenames our uploader produces: alphanum, underscore, dash,
// dot — no slashes, no relative segments.
const SAFE_FILENAME = /^[A-Za-z0-9_-]{1,80}(?:\.[A-Za-z0-9]{1,10})?$/;

@ApiTags('Files')
@Controller({
  path: 'files',
  version: '1',
})
export class FilesLocalController {
  constructor(private readonly filesService: FilesLocalService) {}

  @ApiCreatedResponse({
    type: FileResponseDto,
  })
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<FileResponseDto> {
    return this.filesService.create(file);
  }

  @Get(':path')
  @ApiExcludeEndpoint()
  download(@Param('path') requested: string, @Response() response) {
    if (!requested || !SAFE_FILENAME.test(requested)) {
      throw new BadRequestException('Invalid file name');
    }

    const resolved = path.resolve(FILES_ROOT, requested);
    if (
      resolved !== FILES_ROOT &&
      !resolved.startsWith(FILES_ROOT + path.sep)
    ) {
      throw new NotFoundException();
    }

    return response.sendFile(resolved);
  }
}
