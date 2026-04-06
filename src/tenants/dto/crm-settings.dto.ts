import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { LeadManagementMode } from '../domain/tenant';

export class UpdateTenantCrmSettingsDto {
  @ApiProperty({
    enum: ['unified', 'separated'] as const,
    description:
      "'unified' = single Contacts module (HubSpot-style). " +
      "'separated' = separate Leads + Contacts modules (Salesforce-style).",
    example: 'separated',
  })
  @IsEnum(['unified', 'separated'])
  @IsOptional()
  leadManagementMode?: LeadManagementMode;
}
