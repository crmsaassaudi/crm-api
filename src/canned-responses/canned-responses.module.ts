import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CannedResponsesController } from './canned-responses.controller';
import { CannedResponsesService } from './canned-responses.service';
import { CannedResponseRepository } from './infrastructure/persistence/document/repositories/canned-response.repository';
import {
  CannedResponseSchema,
  CannedResponseSchemaClass,
} from './infrastructure/persistence/document/entities/canned-response.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CannedResponseSchemaClass.name, schema: CannedResponseSchema },
    ]),
  ],
  controllers: [CannedResponsesController],
  providers: [CannedResponsesService, CannedResponseRepository],
  exports: [CannedResponsesService],
})
export class CannedResponsesModule {}
