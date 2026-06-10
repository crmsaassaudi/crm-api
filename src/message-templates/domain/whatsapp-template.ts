import { ApiProperty } from '@nestjs/swagger';

export class WhatsAppTemplateComponent {
  @ApiProperty({ enum: ['HEADER', 'BODY', 'FOOTER', 'BUTTONS'] })
  type: string;

  @ApiProperty({
    enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'],
    required: false,
  })
  format?: string;

  @ApiProperty({ required: false })
  text?: string;

  @ApiProperty({ type: [Object], required: false })
  buttons?: any[];
}

export class WhatsAppTemplate {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'welcome_template' })
  name: string;

  @ApiProperty({ example: 'UTILITY' })
  category: string;

  @ApiProperty({ example: 'vi' })
  language: string;

  @ApiProperty({
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DELETED'],
  })
  status: string;

  @ApiProperty({ required: false })
  metaTemplateId?: string;

  @ApiProperty({ type: [WhatsAppTemplateComponent] })
  components: WhatsAppTemplateComponent[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
