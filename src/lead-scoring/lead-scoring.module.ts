import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  LeadScoringRuleSchema,
  LeadScoringRuleSchemaClass,
} from './lead-scoring-rule.schema';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import { LeadScoringService } from './lead-scoring.service';
import { LeadScoringController } from './lead-scoring.controller';
import { ContactRepository } from '../contacts/infrastructure/persistence/document/repositories/contact.repository';
import {
  ImportJobSchema,
  ImportJobSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/import-job.schema';
import {
  UserSchema,
  UserSchemaClass,
} from '../users/infrastructure/persistence/document/entities/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LeadScoringRuleSchemaClass.name, schema: LeadScoringRuleSchema },
      { name: ContactSchemaClass.name, schema: ContactSchema },
      { name: ImportJobSchemaClass.name, schema: ImportJobSchema },
      { name: UserSchemaClass.name, schema: UserSchema },
    ]),
  ],
  controllers: [LeadScoringController],
  providers: [LeadScoringService, ContactRepository],
  exports: [LeadScoringService],
})
export class LeadScoringModule {}
