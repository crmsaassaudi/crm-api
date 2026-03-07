import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import { DealSchema, DealSchemaClass } from './infrastructure/persistence/document/entities/deal.schema';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: DealSchemaClass.name, schema: DealSchema },
        ]),
    ],
    controllers: [DealsController],
    providers: [DealsService, DealRepository],
    exports: [DealsService],
})
export class DealsModule { }
