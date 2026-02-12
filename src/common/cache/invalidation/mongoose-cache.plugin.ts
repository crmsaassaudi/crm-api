import { Schema } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';

export const MongooseCachePlugin = (
  schema: Schema,
  options: { eventEmitter: EventEmitter2; entityName: string },
) => {
  const { eventEmitter, entityName } = options;

  schema.post('save', function (doc) {
    eventEmitter.emit('entity.created', { entity: entityName, id: doc._id });
    eventEmitter.emit('entity.updated', { entity: entityName, id: doc._id });
  });

  schema.post('findOneAndUpdate', function (doc) {
    if (doc) {
      eventEmitter.emit('entity.updated', { entity: entityName, id: doc._id });
    }
  });

  schema.post('findOneAndDelete', function (doc) {
    if (doc) {
      eventEmitter.emit('entity.deleted', { entity: entityName, id: doc._id });
    }
  });
};
