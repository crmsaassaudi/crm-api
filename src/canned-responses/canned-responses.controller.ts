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
import { CannedResponsesService } from './canned-responses.service';
import {
  CreateCannedResponseDto,
  UpdateCannedResponseDto,
  QueryCannedResponseDto,
} from './dto/canned-response.dto';

@ApiTags('Canned Responses')
@ApiBearerAuth()
@Controller({ path: 'canned-responses', version: '1' })
export class CannedResponsesController {
  constructor(private readonly service: CannedResponsesService) {}

  @Get()
  findAll(@Query() query: QueryCannedResponseDto) {
    return this.service.findAll(query);
  }

  @Post()
  create(@Body() dto: CreateCannedResponseDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateCannedResponseDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
