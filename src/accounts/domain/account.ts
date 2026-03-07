import { ApiProperty } from '@nestjs/swagger';

export class Account {
    @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
    id: string;

    @ApiProperty({ example: 'tenant_1' })
    tenant: string;

    @ApiProperty({ example: 'Acme Corp' })
    name: string;

    @ApiProperty({ example: 'https://acme.com' })
    website?: string;

    @ApiProperty({ example: 'Technology' })
    industry?: string;

    @ApiProperty({ example: 'Enterprise' })
    type?: string;

    @ApiProperty()
    owner?: string;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;

    @ApiProperty()
    deletedAt?: Date;
}
