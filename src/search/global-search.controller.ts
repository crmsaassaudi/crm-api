import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GlobalSearchQueryDto } from './dto/global-search-query.dto';
import { GlobalSearchService } from './global-search.service';

@ApiTags('Search')
@ApiBearerAuth()
@Controller({ path: 'search', version: '1' })
export class GlobalSearchController {
  constructor(private readonly service: GlobalSearchService) {}

  @Get()
  @ApiOkResponse({ description: 'Permission-aware global CRM search results' })
  search(@Query() query: GlobalSearchQueryDto) {
    return this.service.search(query);
  }
}
