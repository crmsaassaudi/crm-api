import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RichMessageTemplatesService } from './rich-message-templates.service';
import {
  CreateRichMessageTemplateDto,
  UpdateRichMessageTemplateDto,
  QueryRichMessageTemplateDto,
} from './dto/rich-message-template.dto';
import { RequirePermission } from '../common/permissions';

@ApiTags('Rich Message Templates')
@ApiBearerAuth()
@Controller({ path: 'rich-message-templates', version: '1' })
export class RichMessageTemplatesController {
  constructor(private readonly service: RichMessageTemplatesService) {}

  @Get()
  @RequirePermission('view', 'channels')
  findAll(@Query() query: QueryRichMessageTemplateDto) {
    return this.service.findAll(query);
  }

  @Post()
  @RequirePermission('manage_system', 'channels')
  create(@Body() dto: CreateRichMessageTemplateDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  @RequirePermission('manage_system', 'channels')
  update(@Param('id') id: string, @Body() dto: UpdateRichMessageTemplateDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('manage_system', 'channels')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
