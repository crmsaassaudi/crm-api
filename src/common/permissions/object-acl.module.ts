import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ObjectAcl, ObjectAclSchema } from './object-acl.schema';
import { ObjectAclService } from './object-acl.service';
import { ObjectAclController } from './object-acl.controller';
import { AclGuard } from './acl.guard';
import { CustomRoleSchemaClass, CustomRoleSchema } from './custom-role.schema';
import { CustomRolesService } from './custom-roles.service';
import { CustomRolesController } from './custom-roles.controller';

/**
 * ObjectAclModule — global module for record-level access control.
 *
 * Marked @Global so ObjectAclService and AclGuard are injectable
 * into any module without needing explicit imports.
 *
 * Import this module in AppModule (crm-api root).
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ObjectAcl.name, schema: ObjectAclSchema },
      { name: CustomRoleSchemaClass.name, schema: CustomRoleSchema },
    ]),
  ],
  controllers: [ObjectAclController, CustomRolesController],
  providers: [ObjectAclService, AclGuard, CustomRolesService],
  exports: [ObjectAclService, AclGuard, CustomRolesService],
})
export class ObjectAclModule {}
