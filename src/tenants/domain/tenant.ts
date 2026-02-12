import { ApiProperty } from '@nestjs/swagger';

const idType = String;

export class Tenant {
    @ApiProperty({
        type: idType,
    })
    id: string;

    @ApiProperty()
    name: string;

    @ApiProperty()
    domain: string;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;

    @ApiProperty()
    deletedAt: Date;
}
