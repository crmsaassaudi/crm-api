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
import { AccountsService } from './accounts.service';
import { Account } from './domain/account';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import { RequirePermission } from '../common/permissions';

@ApiTags('Accounts')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@MaskedResource('Account')
@Controller({
  path: 'accounts',
  version: '1',
})
export class AccountsController {
  constructor(private readonly service: AccountsService) {}

  @Post()
  @RequirePermission('create', 'accounts')
  create(@Body() data: Partial<Account>) {
    return this.service.create(data);
  }

  @Get()
  @RequirePermission('view', 'accounts')
  findAll(@Query() query: any) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequirePermission('view', 'accounts')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @RequirePermission('edit', 'accounts')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: Partial<Account>) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  @RequirePermission('delete', 'accounts')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
