import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DealSchemaClass, DealSchemaDocument } from '../entities/deal.schema';
import { Deal } from '../../../../domain/deal';
import { DealMapper } from '../mappers/deal.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';

@Injectable()
export class DealRepository extends BaseDocumentRepository<DealSchemaDocument, Deal> {
    constructor(
        @InjectModel(DealSchemaClass.name)
        dealModel: Model<DealSchemaDocument>,
        cls: ClsService,
    ) {
        super(dealModel, cls);
    }

    protected mapToDomain(doc: DealSchemaClass): Deal {
        return DealMapper.toDomain(doc);
    }

    protected toPersistence(domain: Deal): DealSchemaClass {
        return DealMapper.toPersistence(domain);
    }
}
