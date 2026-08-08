import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { TemplatesService } from './templates.service';
import { RequirePermission, AuthorizationService } from '../common/permissions';
import {
  CreateMessageTemplateDto,
  QueryMessageTemplateDto,
  UpdateMessageTemplateDto,
} from './dto/message-template.dto';
import {
  PreviewTemplateDto,
  UpsertTemplateVariantDto,
} from './dto/template-variant.dto';
import { TEMPLATE_PURPOSES, TemplatePurpose } from './domain/message-template';

@ApiTags('Templates')
@ApiBearerAuth()
@Controller({ path: 'templates', version: '1' })
export class TemplatesController {
  constructor(
    private readonly service: TemplatesService,
    private readonly authz: AuthorizationService,
    private readonly cls: ClsService,
  ) {}

  /** Whether the caller holds `templates:manage_system` — the bypass for
   * team/tenant-wide templates that don't belong to them. Reuses the same PDP
   * the route guard already ran, just for a second, narrower question. */
  private async canManageSystem(req: any): Promise<boolean> {
    const userId = this.cls.get<string>('userId');
    const tenantId = this.cls.get<string>('tenantId');
    if (!userId) return false;
    const decision = await this.authz.canPerformAction({
      rule: { action: 'manage_system', resource: 'templates' },
      rawUserId: userId,
      tenantHint: tenantId,
      claims: req.user,
    });
    return decision.allowed;
  }

  @Get()
  @RequirePermission('view', 'templates')
  findAll(@Query() query: QueryMessageTemplateDto) {
    return this.service.findAllWithVariants(query);
  }

  @Get('variables')
  @RequirePermission('view', 'templates')
  listVariables(@Query('purpose') purpose: string) {
    if (!TEMPLATE_PURPOSES.includes(purpose as TemplatePurpose)) {
      throw new BadRequestException(`purpose must be one of: ${TEMPLATE_PURPOSES.join(', ')}`);
    }
    return this.service.listVariables(purpose as TemplatePurpose);
  }

  @Get(':id')
  @RequirePermission('view', 'templates')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get(':id/variants')
  @RequirePermission('view', 'templates')
  listVariants(@Param('id') id: string) {
    return this.service.listVariants(id);
  }

  @Post()
  @RequirePermission('create', 'templates')
  create(@Body() dto: CreateMessageTemplateDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('edit', 'templates')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateMessageTemplateDto,
    @Req() req: any,
  ) {
    return this.service.update(id, dto, await this.canManageSystem(req));
  }

  @Delete(':id')
  @RequirePermission('delete', 'templates')
  async delete(@Param('id') id: string, @Req() req: any) {
    return this.service.delete(id, await this.canManageSystem(req));
  }

  @Post(':id/variants')
  @RequirePermission('edit', 'templates')
  async upsertVariant(
    @Param('id') id: string,
    @Body() dto: UpsertTemplateVariantDto,
    @Req() req: any,
  ) {
    return this.service.upsertVariant(id, dto, await this.canManageSystem(req));
  }

  @Delete(':id/variants/:variantId')
  @RequirePermission('edit', 'templates')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteVariant(
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Req() req: any,
  ) {
    return this.service.deleteVariant(id, variantId, await this.canManageSystem(req));
  }

  @Post(':id/preview')
  @RequirePermission('view', 'templates')
  preview(@Param('id') id: string, @Body() dto: PreviewTemplateDto) {
    return this.service.preview(id, dto);
  }

  @Post('whatsapp/sync')
  @RequirePermission('manage_system', 'templates')
  syncWhatsApp() {
    return this.service.syncWhatsApp();
  }

  @Post('whatsapp/upload-media')
  @RequirePermission('manage_system', 'templates')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  async uploadWhatsAppMedia(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No file provided');
    return this.service.uploadWhatsAppMedia(file);
  }
}
