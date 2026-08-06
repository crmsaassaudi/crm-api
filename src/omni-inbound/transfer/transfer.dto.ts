import {
  IsBoolean,
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateTransferDto {
  /**
   * `cold` hands the conversation over immediately; `warm` waits for the target to
   * accept; `consult` brings them in without giving up ownership.
   *
   * A team transfer is always cold: a queue cannot accept or decline, so there is
   * nobody to wait for.
   */
  @IsEnum(['cold', 'warm', 'consult'])
  type: 'cold' | 'warm' | 'consult';

  /**
   * The agent to transfer to. Omit and supply `targetGroupId` to hand the
   * conversation to a team's queue instead.
   *
   * This used to be required, so "pass this to the billing team" was unexpressible
   * — the agent had to pick a specific person, guess who was free, and their
   * transfer failed if that person was at capacity.
   */
  @IsMongoId()
  @IsOptional()
  targetAgentId?: string;

  @IsMongoId()
  @IsOptional()
  targetGroupId?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;

  @IsString()
  @MaxLength(4_000)
  @IsOptional()
  handoffNote?: string;
}

export class RejectTransferDto {
  @IsString()
  @MaxLength(500)
  @IsOptional()
  reason?: string;
}

export class CompleteTransferDto {
  @IsBoolean()
  @IsOptional()
  transferOwnership?: boolean;
}
