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
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { CustomFieldsService } from './custom-fields.service';
import { CustomField } from './domain/custom-field';

@ApiTags('Custom Fields')
@ApiBearerAuth()
@Controller({
  path: 'custom-fields',
  version: '1',
})
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @Get()
  @ApiQuery({ name: 'module', required: false })
  getFields(@Query('module') module?: string): Promise<CustomField[]> {
    return module ? this.service.getByModule(module) : this.service.getAll();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createField(
    @Body()
    body: Omit<CustomField, 'id' | 'tenant' | 'createdAt' | 'updatedAt'>,
  ) {
    return this.service.create(body);
  }

  @Patch(':id')
  updateField(@Param('id') id: string, @Body() body: Partial<CustomField>) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeField(@Param('id') id: string): Promise<void> {
    return this.service.remove(id);
  }
}
