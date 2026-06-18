import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardSchemaClass, DashboardSchema } from './dashboard.schema';
import { DashboardsService } from './dashboards.service';
import { DashboardsController } from './dashboards.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DashboardSchemaClass.name, schema: DashboardSchema },
    ]),
  ],
  controllers: [DashboardsController],
  providers: [DashboardsService],
  exports: [DashboardsService],
})
export class DashboardsModule {}
