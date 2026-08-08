import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission, SensitiveResource } from '../../common/permissions';
import { ContactSegmentsService } from './contact-segments.service';
import {
  ContactSegmentMembersDto,
  CreateContactSegmentDto,
  PreviewContactSegmentDto,
  UpdateContactSegmentDto,
} from './dto/contact-segment.dto';
import { ContactRepository } from '../infrastructure/persistence/document/repositories/contact.repository';

/**
 * Named audiences over contacts.
 *
 * Gated on the `contacts` resource rather than a resource of its own: a segment
 * is a saved question about contacts, and every answer it can give is data the
 * caller could already read one page at a time. A separate permission key would
 * need granting to every existing role before anyone could use the feature.
 */
@ApiTags('Contact Segments')
@ApiBearerAuth()
@SensitiveResource('contacts')
@Controller({ path: 'contact-segments', version: '1' })
export class ContactSegmentsController {
  constructor(
    private readonly service: ContactSegmentsService,
    private readonly contacts: ContactRepository,
  ) {}

  @Get()
  @RequirePermission('view', 'contacts')
  list() {
    return this.service.list();
  }

  /**
   * The filterable fields and their operators. Declared before `:id` so "fields"
   * is never read as a segment id.
   */
  @Get('fields')
  @RequirePermission('view', 'contacts')
  @ApiOkResponse({
    description:
      'Filterable contact fields, including the tenant’s custom fields',
  })
  fields() {
    return this.service.filterFields();
  }

  /**
   * Count an UNSAVED definition. Declared before `:id` so "preview" is never
   * read as a segment id.
   */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('view', 'contacts')
  @ApiOkResponse({
    description: 'Matching contact count and a small sample, scoped to caller',
  })
  async preview(@Body() dto: PreviewContactSegmentDto) {
    const membership = await this.service.compileDraft(dto.filter);
    return this.contacts.previewSegment(membership, dto.sampleSize ?? 5);
  }

  @Post()
  @RequirePermission('create', 'contacts')
  create(@Body() dto: CreateContactSegmentDto) {
    return this.service.create(dto);
  }

  @Get(':id')
  @RequirePermission('view', 'contacts')
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get(':id/members')
  @RequirePermission('view', 'contacts')
  async members(
    @Param('id') id: string,
    @Query() query: ContactSegmentMembersDto,
  ) {
    const membership = await this.service.buildMembershipFilter(id);
    return this.contacts.findManyWithPagination({
      filterOptions: { __segmentFilter: membership },
      paginationOptions: { page: query.page ?? 1, limit: query.limit ?? 25 },
    });
  }

  @Patch(':id')
  @RequirePermission('edit', 'contacts')
  update(@Param('id') id: string, @Body() dto: UpdateContactSegmentDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('delete', 'contacts')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
