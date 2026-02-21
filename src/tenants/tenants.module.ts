import { Module, forwardRef } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { DocumentTenantPersistenceModule } from './infrastructure/persistence/document/document-persistence.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { TenantsAuthController } from './tenants.controller';
import { TenantCreatedListener } from './listeners/tenant-created.listener';

@Module({
    imports: [
        DocumentTenantPersistenceModule,
        // AuthModule provides KeycloakAdminService
        AuthModule,
        // UsersModule provides UserRepository (for upsertWithTenants)
        forwardRef(() => UsersModule),
    ],
    providers: [TenantsService, TenantCreatedListener],
    controllers: [TenantsAuthController],
    exports: [TenantsService, DocumentTenantPersistenceModule],
})
export class TenantsModule { }
