import { IsNotEmpty, IsArray, IsIn, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for linking specific omni-channel messages to an existing Deal or Ticket.
 */
export class LinkMessagesDto {
  @ApiProperty({
    description: 'Type of entity to link messages to',
    enum: ['deal', 'ticket'],
  })
  @IsNotEmpty()
  @IsIn(['deal', 'ticket'])
  targetType: 'deal' | 'ticket';

  @ApiProperty({ description: 'ID of the Deal or Ticket' })
  @IsNotEmpty()
  @IsString()
  targetId: string;

  @ApiProperty({
    description: 'Message IDs to link',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  messageIds: string[];
}
