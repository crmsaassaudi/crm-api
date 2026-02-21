import { Schema } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsServiceManager } from 'nestjs-cls';

export const MongooseCachePlugin = (
  schema: Schema,
  options: { eventEmitter: EventEmitter2; entityName: string },
) => {
  const { eventEmitter, entityName } = options;

  const getTenantId = (): string => {
    try {
      const cls = ClsServiceManager.getClsService();
      return cls.get('activeTenantId') || cls.get('tenantId') || 'global';
    } catch {
      return 'global';
    }
  };

  schema.post('save', function (doc) {
    eventEmitter.emit('entity.created', { entity: entityName, id: doc._id, tenantId: getTenantId() });
    eventEmitter.emit('entity.updated', { entity: entityName, id: doc._id, tenantId: getTenantId() });
  });

  schema.post('findOneAndUpdate', function (doc) {
    if (doc) {
      eventEmitter.emit('entity.updated', { entity: entityName, id: doc._id, tenantId: getTenantId() });
    }
  });

  schema.post('findOneAndDelete', function (doc) {
    if (doc) {
      eventEmitter.emit('entity.deleted', { entity: entityName, id: doc._id, tenantId: getTenantId() });
    }
  });
};
