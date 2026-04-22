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
import { ListViewsService } from '../list-views/list-views.service';

@ApiTags('Contacts')
@ApiBearerAuth()
@UseInterceptors(DataMaskingInterceptor)
@Controller({
  path: 'contacts',
  version: '1',
})
export class ContactsController {
  constructor(
    private readonly service: ContactsService,
    private readonly listViewsService: ListViewsService,
  ) {}

  @ApiCreatedResponse({ type: Contact })
  @Post()
  create(@Body() data: CreateContactDto) {
    return this.service.create(data);
  }

  @ApiOkResponse({ type: [Contact] })
  @Get()
  @MaskedResource('Contact')
  async findAll(@Query() query: any) {
    const result = await this.service.findAll(query);

    // Attach view metadata if viewId is provided
    if (query?.viewId) {
      try {
        const view = await this.listViewsService.getViewById(query.viewId);
        return {
          ...result,
          viewMetadata: {
            viewId: view.id,
            viewName: view.name,
            columns: view.columns,
          },
        };
      } catch {
        // View not found — return data without metadata
      }
    }

    return result;
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

  @Post(':id/change-stage')
  changeStage(
    @Param('id') id: string,
    @Body()
    body: {
      stage: string;
      createAccount?: boolean;
      accountId?: string;
      accountData?: any;
      dealData?: any;
    },
  ) {
    return this.service.changeStage(id, body.stage, body);
  }

  /**
   * @deprecated Use POST :id/change-stage instead.
   * Kept for backward compatibility — delegates to changeStage.
   */
  @Post(':id/convert')
  convertLead(@Param('id') id: string, @Body() body: any) {
    return this.service.changeStage(id, body.stage || 'customer', body);
  }

  /**
   * Link a new omni-channel identity to an existing contact.
   * Body: { channelType: string, senderId: string }
   */
  @Post(':id/merge-identity')
  @ApiOkResponse({ type: Contact })
  mergeIdentity(
    @Param('id') id: string,
    @Body() body: { channelType: string; senderId: string },
  ) {
    return this.service.mergeIdentity(id, body);
  }
}
