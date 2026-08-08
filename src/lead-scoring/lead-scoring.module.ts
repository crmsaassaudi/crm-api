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
import { LeadScoringDecayWorker } from './lead-scoring-decay.worker';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LeadScoringRuleSchemaClass.name, schema: LeadScoringRuleSchema },
      { name: ContactSchemaClass.name, schema: ContactSchema },
    ]),
    ContactsModule,
  ],
  controllers: [LeadScoringController],
  providers: [LeadScoringService, LeadScoringDecayWorker],
  exports: [LeadScoringService],
})
export class LeadScoringModule {}
