import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UserSchema, UserSchemaClass } from './entities/user.schema';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MongooseCachePlugin } from '../../../../common/cache/invalidation/mongoose-cache.plugin';
import { UserRepository } from '../user.repository';
import { UsersDocumentRepository } from './repositories/user.repository';

@Module({
  imports: [

    MongooseModule.forFeatureAsync([
      {
        name: UserSchemaClass.name,
        useFactory: (eventEmitter: EventEmitter2) => {
          const schema = UserSchema;
          schema.plugin(MongooseCachePlugin, {
            eventEmitter,
            entityName: 'User',
          });
          return schema;
        },
        inject: [EventEmitter2],
      },
    ]),
  ],
  providers: [
    {
      provide: UserRepository,
      useClass: UsersDocumentRepository,
    },
  ],
  exports: [UserRepository],
})
export class DocumentUserPersistenceModule { }
