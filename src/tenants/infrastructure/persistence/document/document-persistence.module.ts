import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TenantSchema, TenantSchemaClass } from './entities/tenant.schema';
import {
    TenantAliasReservationSchema,
    TenantAliasReservationSchemaClass,
} from './entities/tenant-alias-reservation.schema';
import { TenantsRepository } from './repositories/tenant.repository';
import { TenantAliasReservationRepository } from './repositories/tenant-alias-reservation.repository';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: TenantSchemaClass.name, schema: TenantSchema },
            {
                name: TenantAliasReservationSchemaClass.name,
                schema: TenantAliasReservationSchema,
            },
        ]),
    ],
    providers: [TenantsRepository, TenantAliasReservationRepository],
    exports: [TenantsRepository, TenantAliasReservationRepository],
})
export class DocumentTenantPersistenceModule { }
