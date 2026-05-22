import { ApiProperty } from '@nestjs/swagger';

export class AiVideoSettings {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ type: [String] })
  timeSlots: string[];

  @ApiProperty()
  retainOriginalDays: number;

  @ApiProperty()
  retainProcessedDays: number;

  @ApiProperty()
  autoCleanupTempFiles: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
