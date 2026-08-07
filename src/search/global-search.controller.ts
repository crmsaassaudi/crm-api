import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GlobalSearchQueryDto } from './dto/global-search-query.dto';
import { GlobalSearchService } from './global-search.service';

@ApiTags('Search')
@ApiBearerAuth()
@Controller({ path: 'search', version: '1' })
export class GlobalSearchController {
  constructor(private readonly service: GlobalSearchService) {}

  /**
   * Tighter than the shared throttle, because this endpoint is not shaped like
   * the others.
   *
   * The global limit is 10 requests/second per tenant+user, which is generous
   * for a form submit and wrong for a search box: one person holding a key down
   * fans out to six modules per request. Five per second still leaves room for
   * a fast typist behind a 300ms debounce, and caps what one tenant can aim at
   * a shared primary.
   */
  @Throttle({ burst: { limit: 5, ttl: 1_000 } })
  @Get()
  @ApiOkResponse({ description: 'Permission-aware global CRM search results' })
  search(@Query() query: GlobalSearchQueryDto) {
    return this.service.search(query);
  }
}
