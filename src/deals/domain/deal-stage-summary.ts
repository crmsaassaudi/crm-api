import { ApiProperty } from '@nestjs/swagger';

/**
 * The stage as a deal reports it, populated on read.
 *
 * Kept out of `deal.ts` so the domain/schema parity guard sees only the Deal's
 * own fields there — a helper class in the same file reads to that check as a
 * pile of Deal columns Mongoose would silently discard.
 */
export class DealStageSummary {
  @ApiProperty()
  id: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  apiName: string;

  @ApiProperty()
  color: string;

  @ApiProperty()
  probability: number;

  @ApiProperty()
  isWon: boolean;

  @ApiProperty()
  isLost: boolean;
}

/** One recorded transition. See `DealStageHistoryEntry` on the schema. */
export class DealStageHistoryItem {
  @ApiProperty({ nullable: true })
  fromStageId: string | null;

  @ApiProperty()
  toStageId: string;

  @ApiProperty()
  changedAt: Date;

  @ApiProperty({ nullable: true })
  changedById: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Time spent in fromStageId (ms)',
  })
  durationMs: number | null;
}
