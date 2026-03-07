import { ApiProperty } from '@nestjs/swagger';

export class Deal {
    @ApiProperty({ example: '60d0fe4f5311236168a109cd' })
    id: string;

    @ApiProperty({ example: 'tenant_1' })
    tenant: string;

    @ApiProperty({ example: 'Acme - Q1 Expansion' })
    name: string;

    @ApiProperty({ example: 10000 })
    amount: number;

    @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
    contact: string;

    @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
    account?: string;

    @ApiProperty({ example: 'discovery' })
    stage: string;

    @ApiProperty({ example: 'main' })
    pipeline: string;

    @ApiProperty()
    closingDate?: Date;

    @ApiProperty()
    owner?: string;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;

    @ApiProperty()
    deletedAt?: Date;
}
