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
import { TagsService } from './tags.service';
import {
  CreateTagDto,
  UpdateTagDto,
  QueryTagDto,
  ReorderTagsDto,
  MergeTagDto,
} from './dto/tag.dto';
import { RequirePermission } from '../common/permissions/permission.decorator';

@ApiTags('Tags')
@ApiBearerAuth()
@Controller({ path: 'tags', version: '1' })
export class TagsController {
  constructor(private readonly service: TagsService) {}

  @Get()
  @RequirePermission('view', 'tags')
  findAll(@Query() query: QueryTagDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermission('view', 'tags')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get(':id/usage')
  @RequirePermission('view', 'tags')
  async getUsage(@Param('id') id: string) {
    const count = await this.service.getUsageCount(id);
    return { count };
  }

  @Post()
  @RequirePermission('create', 'tags')
  create(@Body() dto: CreateTagDto) {
    return this.service.create(dto);
  }

  @Patch('reorder')
  @RequirePermission('edit', 'tags')
  reorder(@Body() dto: ReorderTagsDto) {
    return this.service.reorder(dto.scope, dto.orderedIds);
  }

  @Patch(':id')
  @RequirePermission('edit', 'tags')
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/merge')
  @RequirePermission('edit', 'tags')
  @HttpCode(HttpStatus.NO_CONTENT)
  merge(@Param('id') id: string, @Body() dto: MergeTagDto) {
    return this.service.merge(id, dto.targetTagId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('delete', 'tags')
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
