import { Body, Controller, Param, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { RequirePermission } from '../../common/permissions/permission.decorator';
import { ConversationTransferService } from './conversation-transfer.service';
import {
  CompleteTransferDto,
  CreateTransferDto,
  RejectTransferDto,
} from './transfer.dto';

@Controller({ path: 'omni', version: '1' })
export class ConversationTransferController {
  constructor(
    private readonly transfers: ConversationTransferService,
    private readonly cls: ClsService,
  ) {}

  @Post('conversations/:conversationId/transfers')
  @RequirePermission('assign', 'omni_channel')
  create(
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateTransferDto,
  ) {
    return this.transfers.create(
      this.cls.get<string>('tenantId'),
      conversationId,
      this.cls.get<string>('userId'),
      dto,
    );
  }

  @Post('transfers/:id/accept')
  @RequirePermission('assign', 'omni_channel')
  accept(@Param('id') id: string) {
    return this.transfers.accept(
      this.cls.get<string>('tenantId'),
      id,
      this.cls.get<string>('userId'),
    );
  }

  @Post('transfers/:id/reject')
  @RequirePermission('assign', 'omni_channel')
  reject(@Param('id') id: string, @Body() dto: RejectTransferDto) {
    return this.transfers.reject(
      this.cls.get<string>('tenantId'),
      id,
      this.cls.get<string>('userId'),
      dto.reason,
    );
  }

  @Post('transfers/:id/cancel')
  @RequirePermission('assign', 'omni_channel')
  cancel(@Param('id') id: string) {
    return this.transfers.cancel(
      this.cls.get<string>('tenantId'),
      id,
      this.cls.get<string>('userId'),
    );
  }

  @Post('transfers/:id/complete')
  @RequirePermission('assign', 'omni_channel')
  complete(@Param('id') id: string, @Body() dto: CompleteTransferDto) {
    return this.transfers.completeConsult(
      this.cls.get<string>('tenantId'),
      id,
      this.cls.get<string>('userId'),
      dto.transferOwnership === true,
    );
  }
}
