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
import { ContactsService } from './contacts.service';
import { Contact } from './domain/contact';
import { DataMaskingInterceptor } from '../common/interceptors/data-masking.interceptor';
import { MaskedResource } from '../common/decorators/masked-resource.decorator';
import { SanitizeMaskedInputPipe } from '../common/pipes/sanitize-masked-input.pipe';
import {
  ApiTags,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@ApiTags('Contacts')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@Controller({
  path: 'contacts',
  version: '1',
})
export class ContactsController {
  constructor(private readonly service: ContactsService) {}

  @ApiCreatedResponse({ type: Contact })
  @Post()
  create(@Body() data: CreateContactDto) {
    return this.service.create(data);
  }

  @ApiOkResponse({ type: [Contact] })
  @Get()
  @MaskedResource('Lead') // Default for findAll as it often serves Leads first in current UI context or mixed
  findAll(@Query() query: any) {
    if (query?.isConverted === 'true' || query?.filters?.includes('isConverted":true')) {
      // Dynamic tagging would be better, but interceptor can check query too.
      // For now we use the resource logic.
    }
    return this.service.findAll(query);
  }

  @Get('check-duplicate')
  checkDuplicate(@Query() query: any) {
    return this.service.checkDuplicate(query);
  }

  @ApiOkResponse({ type: Contact })
  @Get(':id')
  @MaskedResource('Contact') // Fallback to Contact if specific resource not identified
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @ApiOkResponse({ type: Contact })
  @Patch(':id')
  @UsePipes(new SanitizeMaskedInputPipe())
  update(@Param('id') id: string, @Body() data: UpdateContactDto) {
    return this.service.update(id, data);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/convert')
  convertLead(@Param('id') id: string, @Body() body: any) {
    return this.service.convertLead(id, body);
  }
}
