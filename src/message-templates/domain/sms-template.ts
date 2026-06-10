import { ApiProperty } from '@nestjs/swagger';

export class SMSTemplate {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'welcome_sms' })
  name: string;

  @ApiProperty({ example: 'Hello {{contact.name}}, welcome to our CRM.' })
  message: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
