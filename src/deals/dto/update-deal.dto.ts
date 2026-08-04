import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateDealDto } from './create-deal.dto';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateDealDto extends PartialType(CreateDealDto) {
  @ApiPropertyOptional({ example: 'Budget constraint' })
  @IsString()
  @IsOptional()
  lostReason?: string;

  // Round-tripped from the GET response's `version` (Mongoose's `__v`). When
  // present, the write is rejected with 409 if another update landed first
  // instead of silently overwriting it.
  @ApiPropertyOptional({ description: 'Optimistic-concurrency version token' })
  @IsInt()
  @Min(0)
  @IsOptional()
  version?: number;

  // wonAt/lostAt are intentionally NOT exposed here — they are stamped by
  // DealsService.applyStageTransition() from the stage's isWon/isLost flags,
  // never taken from client input. A caller acknowledges an out-of-band
  // reopen or Won⇄Lost reclassification via this flag instead.
  @ApiPropertyOptional({
    description:
      'Required to move a deal out of a closed stage, or to reclassify Won ↔ Lost.',
  })
  @IsBoolean()
  @IsOptional()
  allowReopen?: boolean;
}
