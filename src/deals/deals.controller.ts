import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseInterceptors,
  UsePipes,
} from '@nestjs/common';
import { DealsService } from './deals.service';
import { CreateDealDto } from './dto/create-deal.dto';
import { UpdateDealDto } from './dto/update-deal.dto';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission } from '../common/permissions';

@ApiTags('Deals')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@MaskedResource('Deal')
@Controller({
  path: 'deals',
  version: '1',
})
export class DealsController {
  constructor(private readonly service: DealsService) {}

  @Post()
  @RequirePermission('create', 'deals')
  create(@Body() data: CreateDealDto) {
    return this.service.create(data);
  }

  @Get()
  @RequirePermission('view', 'deals')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermission('view', 'deals')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('edit', 'deals')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateDealDto) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'deals')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
