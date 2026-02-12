import { Injectable } from '@nestjs/common';
import { NullableType } from '../../../../../utils/types/nullable.type';
import { SessionRepository } from '../../session.repository';
import { Session } from '../../../../domain/session';
import { SessionSchemaClass } from '../entities/session.schema';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { SessionMapper } from '../mappers/session.mapper';
import { User } from '../../../../../users/domain/user';

import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { SessionSchemaDocument } from '../entities/session.schema';

@Injectable()
export class SessionDocumentRepository
  extends BaseDocumentRepository<SessionSchemaDocument, Session>
  implements SessionRepository {
  constructor(
    @InjectModel(SessionSchemaClass.name)
    sessionModel: Model<SessionSchemaDocument>,
    cls: ClsService,
  ) {
    super(sessionModel, cls);
  }

  protected mapToDomain(doc: SessionSchemaClass): Session {
    return SessionMapper.toDomain(doc);
  }

  protected toPersistence(domain: Session): SessionSchemaClass {
    return SessionMapper.toPersistence(domain);
  }

  async findById(id: Session['id']): Promise<NullableType<Session>> {
    const sessionObject = await this.model.findById(id);
    return sessionObject ? SessionMapper.toDomain(sessionObject) : null;
  }

  async create(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'tenantId'>): Promise<Session> {
    const domainEntity = new Session();
    Object.assign(domainEntity, data);
    domainEntity.tenantId = this.cls.get('tenantId');

    const persistenceModel = SessionMapper.toPersistence(domainEntity);
    const createdSession = new this.model(persistenceModel);
    const sessionObject = await createdSession.save();
    return SessionMapper.toDomain(sessionObject);
  }

  async update(
    id: Session['id'],
    payload: Partial<Session>,
  ): Promise<Session | null> {
    const clonedPayload = { ...payload };
    delete clonedPayload.id;
    delete clonedPayload.createdAt;
    delete clonedPayload.updatedAt;
    delete clonedPayload.deletedAt;

    // We override update to handle full-entity persistence requirement of mapper
    // and implicit tenantId filter if needed (though session ID is usually sufficient).

    const filter = { _id: id.toString() };
    const session = await this.model.findOne(filter); // Use this.model

    if (!session) {
      return null;
    }

    const sessionObject = await this.model.findOneAndUpdate(
      filter,
      SessionMapper.toPersistence({
        ...SessionMapper.toDomain(session),
        ...clonedPayload,
      }),
      { new: true },
    );

    return sessionObject ? SessionMapper.toDomain(sessionObject) : null;
  }

  async deleteById(id: Session['id']): Promise<void> {
    await this.model.deleteOne({ _id: id.toString() });
  }

  async deleteByUserId({ userId }: { userId: User['id'] }): Promise<void> {
    await this.model.deleteMany({ user: userId.toString() });
  }

  async deleteByUserIdWithExclude({
    userId,
    excludeSessionId,
  }: {
    userId: User['id'];
    excludeSessionId: Session['id'];
  }): Promise<void> {
    const transformedCriteria = {
      user: userId.toString(),
      _id: { $not: { $eq: excludeSessionId.toString() } },
    };
    await this.model.deleteMany(transformedCriteria);
  }
}
