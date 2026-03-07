import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { Contact } from './domain/contact';
import { ApiTags, ApiBearerAuth, ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@ApiTags('Contacts')
@ApiBearerAuth()
@Controller({
    path: 'contacts',
    version: '1',
})
export class ContactsController {
    constructor(private readonly service: ContactsService) { }

    @ApiCreatedResponse({ type: Contact })
    @Post()
    create(@Body() data: CreateContactDto) {
        return this.service.create(data);
    }

    @ApiOkResponse({ type: [Contact] })
    @Get()
    findAll(@Query() query: any) {
        return this.service.findAll(query);
    }

    @Get('check-duplicate')
    checkDuplicate(@Query() query: any) {
        return this.service.checkDuplicate(query);
    }

    @ApiOkResponse({ type: Contact })
    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.service.findOne(id);
    }

    @ApiOkResponse({ type: Contact })
    @Patch(':id')
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
