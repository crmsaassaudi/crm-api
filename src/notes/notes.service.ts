import { Injectable, NotFoundException } from '@nestjs/common';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ContactRepository } from '../contacts/infrastructure/persistence/document/repositories/contact.repository';
import { Note } from './domain/note';
import { CreateNoteDto } from './dto/create-note.dto';
import { NoteRepository } from './infrastructure/persistence/document/repositories/note.repository';

@Injectable()
export class NotesService {
  constructor(
    private readonly repository: NoteRepository,
    private readonly contactRepository: ContactRepository,
    private readonly activityLogService: ActivityLogService,
  ) {}

  async findByContact(contactId: string, query: any) {
    await this.ensureContact(contactId);
    const limit = Math.min(Math.max(Number(query?.limit) || 20, 1), 100);
    return this.repository.findByContact({
      contactId,
      limit,
      cursor: query?.cursor,
    });
  }

  async createForContact(
    contactId: string,
    data: CreateNoteDto,
  ): Promise<Note> {
    await this.ensureContact(contactId);
    const title = data.title?.trim() ||
      (data.content.length > 80 ? data.content.slice(0, 80) + '...' : data.content);
    const note = await this.repository.create({
      contactId,
      title,
      content: data.content,
    } as Note);

    const occurredAt = new Date();
    await this.activityLogService.create({
      targetType: 'contact',
      targetId: contactId,
      event: 'note',
      payload: {
        noteId: note.id,
        title: note.title,
        content: note.content,
      },
      occurredAt,
    });
    await this.contactRepository.touchLastActivity(contactId, occurredAt);

    return note;
  }

  async delete(noteId: string): Promise<void> {
    const note = await this.repository.findOne({ _id: noteId } as any);
    if (!note || note.deletedAt) {
      throw new NotFoundException('Note not found');
    }

    await this.repository.softDelete(noteId);
    const occurredAt = new Date();
    await this.activityLogService.create({
      targetType: 'contact',
      targetId: note.contactId,
      event: 'note',
      payload: {
        noteId: note.id,
        title: note.title,
        action: 'deleted',
      },
      occurredAt,
    });
    await this.contactRepository.touchLastActivity(note.contactId, occurredAt);
  }

  private async ensureContact(contactId: string): Promise<void> {
    const contact = await this.contactRepository.findOne({ _id: contactId });
    if (!contact) {
      throw new NotFoundException('Contact not found');
    }
  }
}
