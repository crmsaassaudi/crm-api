import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { ContactRepository } from '../contacts/infrastructure/persistence/document/repositories/contact.repository';
import {
  ContactSchema,
  ContactSchemaClass,
} from '../contacts/infrastructure/persistence/document/entities/contact.schema';
import {
  NoteSchema,
  NoteSchemaClass,
} from './infrastructure/persistence/document/entities/note.schema';
import { NoteRepository } from './infrastructure/persistence/document/repositories/note.repository';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NoteSchemaClass.name, schema: NoteSchema },
      { name: ContactSchemaClass.name, schema: ContactSchema },
    ]),
    ActivityLogModule,
  ],
  controllers: [NotesController],
  providers: [NotesService, NoteRepository, ContactRepository],
  exports: [NotesService, NoteRepository],
})
export class NotesModule {}
