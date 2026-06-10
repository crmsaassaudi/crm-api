import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { MessageTemplatesService } from './message-templates.service';
import {
  CreateEmailTemplateDto,
  UpdateEmailTemplateDto,
} from './dto/email-template.dto';
import {
  CreateSMSTemplateDto,
  UpdateSMSTemplateDto,
} from './dto/sms-template.dto';
import { CreateWhatsAppTemplateDto } from './dto/whatsapp-template.dto';
import { MetaWhatsAppService } from './services/meta-whatsapp.service';

@ApiTags('Message Templates')
@ApiBearerAuth()
@Controller({ path: 'message-templates', version: '1' })
export class MessageTemplatesController {
  constructor(
    private readonly service: MessageTemplatesService,
    private readonly metaWAService: MetaWhatsAppService,
  ) {}

  // ─── EMAIL TEMPLATES ───

  @Get('email')
  findAllEmail() {
    return this.service.findAllEmail();
  }

  @Get('email/:id')
  findEmailById(@Param('id') id: string) {
    return this.service.findEmailById(id);
  }

  @Post('email')
  createEmail(@Body() dto: CreateEmailTemplateDto) {
    return this.service.createEmail(dto);
  }

  @Patch('email/:id')
  updateEmail(@Param('id') id: string, @Body() dto: UpdateEmailTemplateDto) {
    return this.service.updateEmail(id, dto);
  }

  @Delete('email/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteEmail(@Param('id') id: string) {
    return this.service.deleteEmail(id);
  }

  // ─── SMS TEMPLATES ───

  @Get('sms')
  findAllSMS() {
    return this.service.findAllSMS();
  }

  @Get('sms/:id')
  findSMSById(@Param('id') id: string) {
    return this.service.findSMSById(id);
  }

  @Post('sms')
  createSMS(@Body() dto: CreateSMSTemplateDto) {
    return this.service.createSMS(dto);
  }

  @Patch('sms/:id')
  updateSMS(@Param('id') id: string, @Body() dto: UpdateSMSTemplateDto) {
    return this.service.updateSMS(id, dto);
  }

  @Delete('sms/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSMS(@Param('id') id: string) {
    return this.service.deleteSMS(id);
  }

  // ─── WHATSAPP TEMPLATES ───

  @Get('whatsapp')
  findAllWhatsApp() {
    return this.service.findAllWhatsApp();
  }

  @Get('whatsapp/:id')
  findWhatsAppById(@Param('id') id: string) {
    return this.service.findWhatsAppById(id);
  }

  @Post('whatsapp')
  createWhatsApp(@Body() dto: CreateWhatsAppTemplateDto) {
    return this.service.createWhatsApp(dto);
  }

  @Delete('whatsapp/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteWhatsApp(@Param('id') id: string) {
    return this.service.deleteWhatsApp(id);
  }

  @Post('whatsapp/sync')
  syncWhatsApp() {
    return this.service.syncWhatsAppWithMeta();
  }

  @Post('whatsapp/upload-media')
  @UseInterceptors(FileInterceptor('file'))
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
  async uploadWhatsAppMedia(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    const mediaId = await this.metaWAService.uploadMedia(
      file.buffer,
      file.originalname,
      file.mimetype,
    );
    return { mediaId };
  }
}
