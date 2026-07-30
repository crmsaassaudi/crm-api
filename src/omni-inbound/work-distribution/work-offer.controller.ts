import { Body, Controller, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import { RequirePermission } from '../../common/permissions/permission.decorator';
import { WorkDistributionService } from './work-distribution.service';

class DeclineOfferDto {
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}

@Controller({ path: 'omni/work-offers', version: '1' })
export class WorkOfferController {
  constructor(
    private readonly distribution: WorkDistributionService,
    private readonly cls: ClsService,
  ) {}

  @Post(':id/accept')
  @RequirePermission('edit', 'omni_channel')
  accept(@Param('id') id: string) {
    return this.distribution.acceptOffer(
      this.cls.get<string>('tenantId'),
      id,
      this.cls.get<string>('userId'),
    );
  }

  @Post(':id/decline')
  @RequirePermission('edit', 'omni_channel')
  decline(@Param('id') id: string, @Body() dto: DeclineOfferDto) {
    return this.distribution.declineOffer(
      this.cls.get<string>('tenantId'),
      id,
      this.cls.get<string>('userId'),
      dto.reason,
    );
  }
}
