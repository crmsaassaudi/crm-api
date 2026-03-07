import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class Contact {
    @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
    id: string;

    @ApiProperty({ example: 'tenant_1' })
    tenant: string;

    @ApiProperty({ example: 'John' })
    firstName: string;

    @ApiProperty({ example: 'Doe' })
    lastName: string;

    @ApiProperty({ example: ['john.doe@example.com'] })
    email: string[];

    @ApiProperty({ example: ['+15551234567'] })
    phone: string[];

    @ApiProperty({ example: false })
    isConverted: boolean;

    @ApiProperty({ example: 'lead' })
    lifecycleStage: string;

    @ApiProperty({ example: 'new' })
    status: string;

    @ApiProperty({ example: 'Acme Corp' })
    companyName?: string;

    @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
    account?: string;

    @ApiProperty({ example: 'Sales Manager' })
    title?: string;

    @ApiProperty({ example: '1' })
    source?: string;

    @ApiProperty({ example: 50 })
    score?: number;

    @ApiProperty({ type: 'string', example: '60d0fe4f5311236168a109cc' })
    owner?: User | string;

    @ApiProperty({ type: 'string' })
    createdBy: User | string;

    @ApiProperty({ type: 'string' })
    updatedBy: User | string;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;

    @ApiProperty()
    deletedAt?: Date;
}
