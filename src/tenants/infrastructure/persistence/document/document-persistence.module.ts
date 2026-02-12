import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TenantSchema, TenantSchemaClass } from './entities/tenant.schema';
import { TenantsRepository } from './repositories/tenant.repository';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: TenantSchemaClass.name, schema: TenantSchema },
        ]),
    ],
    providers: [TenantsRepository],
    exports: [TenantsRepository],
})
export class DocumentTenantPersistenceModule { }
