import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ObjectAcl, ObjectAclSchema } from './object-acl.schema';
import { ObjectAclService } from './object-acl.service';
import { ObjectAclController } from './object-acl.controller';
import { AclGuard } from './acl.guard';
import { CustomRoleSchemaClass, CustomRoleSchema } from './custom-role.schema';
import { CustomRolesService } from './custom-roles.service';
import { CustomRolesController } from './custom-roles.controller';
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
  ],
  providers: [
    ObjectAclService,
    CustomRolesService,
    RoleAssignmentService,
    AccessPolicyService,
    AuthzPermissionCacheService,
    AuthorizationService,
    AuthzPermissionInvalidationListener,
    AclGuard,
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
    RoleAssignmentService,
    AccessPolicyService,
    AclGuard,
  ],
})
export class AuthorizationModule {}
