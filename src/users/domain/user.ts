import { Exclude, Expose } from 'class-transformer';
import { FileType } from '../../files/domain/file';
import { Role } from '../../roles/domain/role';
import { Status } from '../../statuses/domain/status';
import { ApiProperty } from '@nestjs/swagger';

const idType = String;

export class User {
  @ApiProperty({
    type: idType,
  })
  id: number | string;

  @ApiProperty({
    type: [Object],
  })
  tenants: {
    tenantId: string;
    roles: string[];
    joinedAt: Date;
  }[];

  @ApiProperty({
    type: String,
    example: 'john.doe@example.com',
  })
  @Expose({ groups: ['me', 'admin'] })
  email: string | null;

  @Exclude({ toPlainOnly: true })
  password?: string;

  @ApiProperty({
    type: String,
    example: 'email',
  })
  @Expose({ groups: ['me', 'admin'] })
  provider: string;

  @ApiProperty({
    type: String,
    example: '1234567890',
  })
  @Expose({ groups: ['me', 'admin'] })
  keycloakId?: string | null;

  @ApiProperty({
    type: String,
    example: 'John',
  })
  firstName: string | null;

  @ApiProperty({
    type: String,
    example: 'Doe',
  })
  lastName: string | null;

  @ApiProperty({
    type: () => FileType,
  })
  photo?: FileType | null;

  @ApiProperty({
    type: () => Role,
    description: 'Platform-level role (SUPER_ADMIN or USER)',
  })
  platformRole?: Role | null;

  @ApiProperty({
    type: () => Status,
  })
  status?: Status;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt: Date;

  @ApiProperty()
  version?: number;

  @ApiProperty({
    description:
      'Max concurrent omni-channel conversations (null = use tenant default)',
    example: 10,
    required: false,
  })
  omniMaxCapacity?: number | null;

  @ApiProperty({
    description: 'Skill tags for skill-based routing',
    example: ['spanish', 'billing'],
    required: false,
  })
  skills?: string[];

  @ApiProperty({
    description:
      'User-level i18n overrides. Null fields inherit from tenant defaults.',
    required: false,
  })
  i18nPreferences?: {
    /** Override locale (null = use tenant default) */
    locale?: string | null;
    /** Override timezone (null = use tenant default) */
    timezone?: string | null;
  } | null;
}
