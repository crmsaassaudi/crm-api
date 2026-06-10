import { ApiProperty } from '@nestjs/swagger';

export class EmailTemplate {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'welcome_email' })
  name: string;

  @ApiProperty({ example: 'Welcome to our service!' })
  subject: string;

  @ApiProperty({ example: '<h1>Hello {{contact.name}}</h1>' })
  htmlContent: string;

  @ApiProperty({ example: '{}', required: false })
  designJson?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
