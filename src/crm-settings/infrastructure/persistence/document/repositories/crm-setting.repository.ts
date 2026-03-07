import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CrmSettingSchemaClass, CrmSettingSchemaDocument } from '../entities/crm-setting.schema';
import { CrmSetting } from '../../../../domain/crm-setting';
import { CrmSettingMapper } from '../mappers/crm-setting.mapper';

@Injectable()
export class CrmSettingRepository {
    constructor(
        @InjectModel(CrmSettingSchemaClass.name)
        private readonly model: Model<CrmSettingSchemaDocument>,
    ) { }

    async findOne(tenant: string, key: string): Promise<CrmSetting | null> {
        const doc = await this.model.findOne({ tenant, key }).exec();
        return doc ? CrmSettingMapper.toDomain(doc) : null;
    }

    async update(tenant: string, key: string, value: any): Promise<CrmSetting> {
        const doc = await this.model.findOneAndUpdate(
            { tenant, key },
            { value },
            { upsert: true, new: true },
        ).exec();
        return CrmSettingMapper.toDomain(doc);
    }
}
