import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrgUnitsController } from './org-units.controller';
import { OrgUnitsService } from './org-units.service';
import { OrgUnitRepository } from './infrastructure/persistence/document/repositories/org-unit.repository';
import {
  OrgUnitSchema,
  OrgUnitSchemaClass,
} from './infrastructure/persistence/document/entities/org-unit.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OrgUnitSchemaClass.name, schema: OrgUnitSchema },
    ]),
    forwardRef(() => UsersModule),
  ],
  controllers: [OrgUnitsController],
  providers: [OrgUnitsService, OrgUnitRepository],
  exports: [OrgUnitsService, OrgUnitRepository],
})
export class OrgUnitsModule {}
