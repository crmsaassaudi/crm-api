import { ApiProperty } from '@nestjs/swagger';

export class CannedResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenant: string;

  @ApiProperty({ example: '/hi' })
  shortcut: string;

  @ApiProperty({ example: 'Hello! How can I help?' })
  content: string;

  @ApiProperty({ example: 'Greeting' })
  category: string;

  @ApiProperty({ enum: ['Public', 'Private', 'Team'] })
  scope: string;

  @ApiProperty()
  createdBy: string;

  @ApiProperty({ type: [String] })
  attachments: string[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
