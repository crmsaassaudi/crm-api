---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/repositories/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.repository.ts
---
import { Injectable } from '@nestjs/common';
import { NullableType } from '../../../../../utils/types/nullable.type';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ClientSession } from 'mongoose';
import { <%= name %>SchemaClass } from '../entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema';
import { <%= name %>Repository } from '../../<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.repository';
import { <%= name %> } from '../../../../domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
import { <%= name %>Mapper } from '../mappers/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.mapper';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';

@Injectable()
export class <%= name %>DocumentRepository implements <%= name %>Repository {
  constructor(
    @InjectModel(<%= name %>SchemaClass.name)
    private readonly <%= h.inflection.camelize(name, true) %>Model: Model<<%= name %>SchemaClass>,
  ) {}

  async create(
    data: <%= name %>,
    options?: { session?: ClientSession },
  ): Promise<<%= name %>> {
    const persistenceModel = <%= name %>Mapper.toPersistence(data);
    const createdEntity = new this.<%= h.inflection.camelize(name, true) %>Model(persistenceModel);
    const entityObject = await createdEntity.save({ session: options?.session });
    return <%= name %>Mapper.toDomain(entityObject);
  }

  async findAllWithPagination({
    paginationOptions,
  }: {
    paginationOptions: IPaginationOptions;
  }, options?: { session?: ClientSession }): Promise<<%= name %>[]> {
    const entityObjects = await this.<%= h.inflection.camelize(name, true) %>Model
      .find()
      .session(options?.session || null)
      .skip((paginationOptions.page - 1) * paginationOptions.limit)
      .limit(paginationOptions.limit);

    return entityObjects.map((entityObject) =>
      <%= name %>Mapper.toDomain(entityObject),
    );
  }

  async findById(
    id: <%= name %>['id'],
    options?: { session?: ClientSession },
  ): Promise<NullableType<<%= name %>>> {
    const entityObject = await this.<%= h.inflection.camelize(name, true) %>Model
      .findById(id)
      .session(options?.session || null);
    return entityObject ? <%= name %>Mapper.toDomain(entityObject) : null;
  }

  async findByIds(
    ids: <%= name %>['id'][],
    options?: { session?: ClientSession },
  ): Promise<<%= name %>[]> {
    const entityObjects = await this.<%= h.inflection.camelize(name, true) %>Model
      .find({ _id: { $in: ids } })
      .session(options?.session || null);
    return entityObjects.map((entityObject) =>
      <%= name %>Mapper.toDomain(entityObject),
    );
  }

  async update(
    id: <%= name %>['id'],
    payload: Partial<<%= name %>>,
    options?: { session?: ClientSession },
  ): Promise<NullableType<<%= name %>>> {
    const clonedPayload = { ...payload };
    delete clonedPayload.id;

    const filter = { _id: id };
    
    // Tìm bản ghi hiện tại với session
    const entity = await this.<%= h.inflection.camelize(name, true) %>Model
      .findOne(filter)
      .session(options?.session || null);

    if (!entity) {
      throw new Error('Record not found');
    }

    const entityObject = await this.<%= h.inflection.camelize(name, true) %>Model.findOneAndUpdate(
      filter,
      <%= name %>Mapper.toPersistence({
        ...<%= name %>Mapper.toDomain(entity),
        ...clonedPayload,
      }),
      { 
        new: true,
        session: options?.session // Quan trọng cho ACID
      },
    );

    return entityObject ? <%= name %>Mapper.toDomain(entityObject) : null;
  }

  async remove(
    id: <%= name %>['id'],
    options?: { session?: ClientSession },
  ): Promise<void> {
    await this.<%= h.inflection.camelize(name, true) %>Model
      .deleteOne({ _id: id })
      .session(options?.session || null);
  }
}
