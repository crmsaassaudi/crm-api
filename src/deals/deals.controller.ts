import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { DealsService } from './deals.service';
import { Deal } from './domain/deal';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Deals')
@ApiBearerAuth()
@Controller({
    path: 'deals',
    version: '1',
})
export class DealsController {
    constructor(private readonly service: DealsService) { }

    @Post()
    create(@Body() data: Partial<Deal>) {
        return this.service.create(data);
    }

    @Get()
    findAll() {
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.service.findOne(id);
    }

    @Patch(':id')
    update(@Param('id') id: string, @Body() data: Partial<Deal>) {
        return this.service.update(id, data);
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.service.remove(id);
    }
}
