import { Injectable } from '@nestjs/common';

import { FileRepository } from '../../file.repository';
import { FileSchemaClass, FileSchemaDocument } from '../entities/file.schema';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FileType } from '../../../../domain/file';

import { FileMapper } from '../mappers/file.mapper';
import { NullableType } from '../../../../../utils/types/nullable.type';

import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';

@Injectable()
export class FileDocumentRepository
  extends BaseDocumentRepository<FileSchemaDocument, FileType>
  implements FileRepository
{
  constructor(
    @InjectModel(FileSchemaClass.name)
    fileModel: Model<FileSchemaDocument>,
    cls: ClsService,
  ) {
    super(fileModel, cls);
  }

  protected mapToDomain(doc: FileSchemaClass): FileType {
    return FileMapper.toDomain(doc);
  }

  protected toPersistence(domain: FileType): FileSchemaClass {
    return FileMapper.toPersistence(domain);
  }

  async create(
    data: Omit<
      FileType,
      'id' | 'createdAt' | 'updatedAt' | 'version' | 'tenantId'
    >,
  ): Promise<FileType> {
    const domainEntity = new FileType();
    Object.assign(domainEntity, data);
    domainEntity.tenantId = this.cls.get('tenantId');

    const persistenceModel = FileMapper.toPersistence(domainEntity);
    const createdFile = new this.model(persistenceModel);
    const fileObject = await createdFile.save();
    return FileMapper.toDomain(fileObject);
  }

  async findById(id: FileType['id']): Promise<NullableType<FileType>> {
    const fileObject = await this.model.findById(id);
    return fileObject ? FileMapper.toDomain(fileObject) : null;
  }

  async findByIds(ids: FileType['id'][]): Promise<FileType[]> {
    const fileObjects = await this.model.find({ _id: { $in: ids } });
    return fileObjects.map((fileObject) => FileMapper.toDomain(fileObject));
  }
}
