import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsMongoId, IsOptional } from 'class-validator';

export class LinkContactDto {
  /**
   * The contact to link to. Omit to create a new contact from the conversation's
   * customer details — the two inbox actions ("Merge contact" / "Save lead")
   * differ only by whether the agent picked an existing record.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  contactId?: string;
}
