import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Search message bodies within a conversation, or within one contact's
 * conversations.
 *
 * Exactly one scope — `conversationId` or `contactId` — is required, and the
 * controller refuses the request when neither is present. That is a deliberate
 * product boundary rather than an oversight: the cost of this query is bounded
 * by the conversations it is given, and an unbounded variant would be a
 * tenant-wide scan over the largest collection in the system, getting slower
 * every week while looking like a working feature. Tenant-wide message search
 * belongs in the search engine, and this endpoint is what makes the common case
 * ("what did this customer say about X") work today without it.
 */
export class SearchMessagesQueryDto {
  @ApiProperty({ example: 'refund', minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;

  @ApiPropertyOptional({ description: 'Search inside this one conversation' })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({
    description: "Search across this contact's conversations",
  })
  @IsOptional()
  @IsString()
  contactId?: string;

  @ApiPropertyOptional({ description: 'Max 50, default 20' })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({
    description: 'Opaque cursor from a previous response',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
