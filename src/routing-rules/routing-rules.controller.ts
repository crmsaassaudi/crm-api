import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { RoutingRulesService } from './routing-rules.service';
import {
  CreateRoutingRuleDto,
  UpdateRoutingRuleDto,
  ReorderRoutingRulesDto,
} from './dto/routing-rule.dto';

@ApiTags('Routing Rules')
@ApiBearerAuth()
@Controller({ path: 'routing-rules', version: '1' })
export class RoutingRulesController {
  constructor(private readonly service: RoutingRulesService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post()
  create(@Body() dto: CreateRoutingRuleDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRoutingRuleDto) {
    return this.service.update(id, dto);
  }

  @Put('reorder')
  reorder(@Body() dto: ReorderRoutingRulesDto) {
    return this.service.reorder(dto.orderedIds);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
