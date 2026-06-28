import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AgentStateSegmentSchemaClass,
  AgentStateSegmentSchema,
} from '../../omni-inbound/infrastructure/persistence/document/entities/agent-state-segment.schema';
import {
  InteractionSegmentSchemaClass,
  InteractionSegmentSchema,
} from '../../omni-inbound/infrastructure/persistence/document/entities/interaction-segment.schema';
import { UsersModule } from '../../users/users.module';
import { CrmSettingsModule } from '../../crm-settings/crm-settings.module';
import { AgentReportController } from './agent-report.controller';
import { AgentReportService } from './agent-report.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: AgentStateSegmentSchemaClass.name,
        schema: AgentStateSegmentSchema,
      },
      {
        name: InteractionSegmentSchemaClass.name,
        schema: InteractionSegmentSchema,
      },
    ]),
    UsersModule,
    CrmSettingsModule,
  ],
  controllers: [AgentReportController],
  providers: [AgentReportService],
})
export class AgentReportModule {}
