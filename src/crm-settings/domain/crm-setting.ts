import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';

export class CrmSetting {
    @ApiProperty({ example: 'tenant_1' })
    tenant: string;

    @ApiProperty({ example: 'contact_lifecycle' })
    key: string;

    @ApiProperty({ example: { pipelineEnabled: true, stages: [] } })
    value: any;

    @ApiProperty()
    createdAt: Date;

    @ApiProperty()
    updatedAt: Date;
}
