import { Note } from '../../../../domain/note';
import { NoteSchemaClass } from '../entities/note.schema';

export class NoteMapper {
  static toDomain(raw: NoteSchemaClass): Note {
    const entity = new Note();
    entity.id = raw._id.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.contactId = raw.contactId?.toString();
    entity.title = raw.title;
    entity.content = raw.content;
    entity.createdById = raw.createdById?.toString();
    entity.updatedById = raw.updatedById?.toString();
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    entity.deletedAt = raw.deletedAt;
    return entity;
  }

  static toPersistence(entity: Note): NoteSchemaClass {
    const persistence = new NoteSchemaClass();
    if (entity.id) {
      persistence._id = entity.id;
    }
    persistence.tenantId = entity.tenantId;
    persistence.contactId = entity.contactId;
    persistence.title = entity.title;
    persistence.content = entity.content;
    persistence.createdById = entity.createdById;
    persistence.updatedById = entity.updatedById;
    persistence.createdAt = entity.createdAt;
    persistence.updatedAt = entity.updatedAt;
    persistence.deletedAt = entity.deletedAt;
    return persistence;
  }
}
