import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EscalationPoliciesController } from './escalation-policies.controller';
import { EscalationPoliciesService } from './escalation-policies.service';
import { EscalationPolicyRepository } from './infrastructure/persistence/document/repositories/escalation-policy.repository';
import {
  EscalationPolicySchema,
  EscalationPolicySchemaClass,
} from './infrastructure/persistence/document/entities/escalation-policy.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: EscalationPolicySchemaClass.name,
        schema: EscalationPolicySchema,
      },
    ]),
  ],
  controllers: [EscalationPoliciesController],
  providers: [EscalationPoliciesService, EscalationPolicyRepository],
  exports: [EscalationPoliciesService],
})
export class EscalationPoliciesModule {}
