import { Module, Global } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ObjectAcl, ObjectAclSchema } from './object-acl.schema';
import { ObjectAclService } from './object-acl.service';
import { ObjectAclController } from './object-acl.controller';
import { AclGuard } from './acl.guard';
import { CustomRoleSchemaClass, CustomRoleSchema } from './custom-role.schema';
import { CustomRolesService } from './custom-roles.service';
import { CustomRolesController } from './custom-roles.controller';
import { SystemRolesSeederService } from './system-roles-seeder.service';
import { AuthzPermissionCacheService } from './authz-permission-cache.service';
import { AuthzPermissionInvalidationListener } from './authz-permission-invalidation.listener';
import { AuthorizationService } from './authorization.service';
import {
  RoleAssignmentSchemaClass,
  RoleAssignmentSchema,
} from './role-assignment.schema';
import { RoleAssignmentService } from './role-assignment.service';
import { RoleAssignmentController } from './role-assignment.controller';
import {
  AccessPolicySchemaClass,
  AccessPolicySchema,
} from './access-policy.schema';
import { AccessPolicyService } from './access-policy.service';
import { AccessPolicyController } from './access-policy.controller';
import { FieldMaskingInterceptor } from './field-masking.interceptor';
import { CommonCacheModule } from '../cache/common-cache.module';
import { ResourceLoaderRegistry } from './resource-loader.registry';
import { MePermissionsController } from './me-permissions.controller';

/**
 * AuthorizationModule — the single home of the authorization stack.
 *
 * Owns every authorization building block so there is exactly one place that
 * wires them, and one exported entry point ({@link AuthorizationService}, the
 * PDP) that guards and business code depend on:
 *   - AuthorizationService          → the PDP facade (RBAC ∘ super-admin ∘ ACL)
 *   - AuthzPermissionCacheService   → cached effective-permission sets (RBAC)
 *   - ObjectAclService              → record-level ACL
 *   - CustomRolesService            → tenant custom-role catalog
 *   - Acl/Permission guards         → thin adapters over the PDP
 *
 * @Global so any feature module gets the PDP without an explicit import.
 * Depends only on globally-provided RedisModule / ClsModule at runtime.
 */
@Global()
@Module({
  imports: [
    // Permission changes must purge the per-user HTTP response cache too (C-03),
    // otherwise a revoked principal keeps being served pre-revocation payloads.
    CommonCacheModule,
    MongooseModule.forFeature([
      { name: ObjectAcl.name, schema: ObjectAclSchema },
      { name: CustomRoleSchemaClass.name, schema: CustomRoleSchema },
      { name: RoleAssignmentSchemaClass.name, schema: RoleAssignmentSchema },
      { name: AccessPolicySchemaClass.name, schema: AccessPolicySchema },
    ]),
  ],
  controllers: [
    ObjectAclController,
    CustomRolesController,
    RoleAssignmentController,
    AccessPolicyController,
    MePermissionsController,
  ],
  providers: [
    ObjectAclService,
    CustomRolesService,
    SystemRolesSeederService,
    RoleAssignmentService,
    AccessPolicyService,
    AuthzPermissionCacheService,
    AuthorizationService,
    AuthzPermissionInvalidationListener,
    ResourceLoaderRegistry,
    AclGuard,
    {
      // C-01: the record-level PEP is now part of the global guard chain. It is
      // a no-op on handlers without @UseAcl, so this cannot break existing
      // routes — but it does mean opting a route into record-level ACL/ABAC is
      // a one-line decorator instead of a wiring change that was never done.
      // Runs after PermissionGuard (declaration order in app.module.ts is the
      // execution order), so the resource-level grant is already established.
      provide: APP_GUARD,
      useClass: AclGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: FieldMaskingInterceptor,
    },
  ],
  exports: [
    AuthorizationService,
    AuthzPermissionCacheService,
    ObjectAclService,
    CustomRolesService,
    SystemRolesSeederService,
    RoleAssignmentService,
    AccessPolicyService,
    AclGuard,
    ResourceLoaderRegistry,
  ],
})
export class AuthorizationModule {}
