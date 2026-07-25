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
import { RequirePermission } from '../common/permissions';

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
  @RequirePermission('view', 'channels')
  findAllEmail() {
    return this.service.findAllEmail();
  }

  @Get('email/:id')
  @RequirePermission('view', 'channels')
  findEmailById(@Param('id') id: string) {
    return this.service.findEmailById(id);
  }

  @Post('email')
  @RequirePermission('manage_system', 'channels')
  createEmail(@Body() dto: CreateEmailTemplateDto) {
    return this.service.createEmail(dto);
  }

  @Patch('email/:id')
  @RequirePermission('manage_system', 'channels')
  updateEmail(@Param('id') id: string, @Body() dto: UpdateEmailTemplateDto) {
    return this.service.updateEmail(id, dto);
  }

  @Delete('email/:id')
  @RequirePermission('manage_system', 'channels')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteEmail(@Param('id') id: string) {
    return this.service.deleteEmail(id);
  }

  // ─── SMS TEMPLATES ───

  @Get('sms')
  @RequirePermission('view', 'channels')
  findAllSMS() {
    return this.service.findAllSMS();
  }

  @Get('sms/:id')
  @RequirePermission('view', 'channels')
  findSMSById(@Param('id') id: string) {
    return this.service.findSMSById(id);
  }

  @Post('sms')
  @RequirePermission('manage_system', 'channels')
  createSMS(@Body() dto: CreateSMSTemplateDto) {
    return this.service.createSMS(dto);
  }

  @Patch('sms/:id')
  @RequirePermission('manage_system', 'channels')
  updateSMS(@Param('id') id: string, @Body() dto: UpdateSMSTemplateDto) {
    return this.service.updateSMS(id, dto);
  }

  @Delete('sms/:id')
  @RequirePermission('manage_system', 'channels')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSMS(@Param('id') id: string) {
    return this.service.deleteSMS(id);
  }

  // ─── WHATSAPP TEMPLATES ───

  @Get('whatsapp')
  @RequirePermission('view', 'channels')
  findAllWhatsApp() {
    return this.service.findAllWhatsApp();
  }

  @Get('whatsapp/:id')
  @RequirePermission('view', 'channels')
  findWhatsAppById(@Param('id') id: string) {
    return this.service.findWhatsAppById(id);
  }

  @Post('whatsapp')
  @RequirePermission('manage_system', 'channels')
  createWhatsApp(@Body() dto: CreateWhatsAppTemplateDto) {
    return this.service.createWhatsApp(dto);
  }

  @Delete('whatsapp/:id')
  @RequirePermission('manage_system', 'channels')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteWhatsApp(@Param('id') id: string) {
    return this.service.deleteWhatsApp(id);
  }

  @Post('whatsapp/sync')
  @RequirePermission('manage_system', 'channels')
  syncWhatsApp() {
    return this.service.syncWhatsAppWithMeta();
  }

  @Post('whatsapp/upload-media')
  @RequirePermission('manage_system', 'channels')
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
