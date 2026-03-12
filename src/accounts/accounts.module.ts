import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import {
  AccountSchema,
  AccountSchemaClass,
} from './infrastructure/persistence/document/entities/account.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccountSchemaClass.name, schema: AccountSchema },
    ]),
  ],
  controllers: [AccountsController],
  providers: [AccountsService, AccountRepository],
  exports: [AccountsService],
})
export class AccountsModule {}
