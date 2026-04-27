import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountSettingsController } from './account-settings.controller';
import { AccountSettingsService } from './account-settings.service';
import {
  AccountStatusSchemaClass,
  AccountStatusSchema,
} from './entities/account-status.schema';
import {
  AccountTypeSchemaClass,
  AccountTypeSchema,
} from './entities/account-type.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccountStatusSchemaClass.name, schema: AccountStatusSchema },
      { name: AccountTypeSchemaClass.name, schema: AccountTypeSchema },
    ]),
  ],
  controllers: [AccountSettingsController],
  providers: [AccountSettingsService],
  exports: [AccountSettingsService],
})
export class AccountSettingsModule {}
