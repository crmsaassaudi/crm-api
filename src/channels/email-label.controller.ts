import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { EmailLabelService } from './services/email-label.service';
import { RequirePermission } from '../common/permissions';

@ApiTags('Mailbox Labels')
@ApiBearerAuth()
@Controller({ version: '1' })
export class EmailLabelController {
  constructor(private readonly labels: EmailLabelService) {}

  @Get('mailboxes/:id/labels')
  @RequirePermission('view', 'email_settings')
  listLabels(
    @Param('id') id: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('includeDeleted') includeDeleted?: string,
    @Query('refreshProvider') refreshProvider?: string,
  ) {
    return this.labels.listLabels(id, {
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
      includeDeleted: includeDeleted === 'true',
      refreshProvider: refreshProvider === 'true',
    });
  }

  @Post('mailboxes/:id/labels/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('manage_system', 'email_settings')
  reconcile(@Param('id') id: string) {
    return this.labels.reconcile(id);
  }
}
