import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DealSchema,
  DealSchemaClass,
} from '../../deals/infrastructure/persistence/document/entities/deal.schema';
import { DealReportController } from './deal-report.controller';
import { DealReportService } from './deal-report.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DealSchemaClass.name, schema: DealSchema },
    ]),
  ],
  controllers: [DealReportController],
  providers: [DealReportService],
})
export class DealReportModule {}
