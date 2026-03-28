import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NoteRepository, OmniNote } from '../repositories/note.repository';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';

@Injectable()
export class NoteService {
  private readonly logger = new Logger(NoteService.name);

  constructor(
    private readonly noteRepo: NoteRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new note on a conversation.
   * Emits `omni.conversation.note_added` for audit trail + WebSocket.
   */
  async createNote(
    tenantId: string,
    conversationId: string,
    authorId: string,
    content: string,
    isPrivate = true,
    mentions: string[] = [],
  ): Promise<OmniNote> {
    const note = await this.noteRepo.create({
      tenant: tenantId,
      conversationId,
      content,
      authorId,
      mentions,
      isPrivate,
    } as any);

    this.eventEmitter.emit('omni.conversation.note_added', {
      tenantId,
      conversationId,
      noteId: note.id,
      authorId,
      isPrivate,
      content: content.substring(0, 100), // preview for activity log
    });

    this.logger.log(
      `Note ${note.id} added to conversation ${conversationId} by ${authorId}`,
    );

    return note;
  }

  /**
   * Get paginated notes for a conversation.
   */
  async getNotes(
    conversationId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginationResponseDto<OmniNote>> {
    return this.noteRepo.findByConversation(conversationId, page, limit);
  }

  /**
   * Update an existing note (only content and isPrivate).
   */
  async updateNote(
    noteId: string,
    content: string,
    isPrivate?: boolean,
  ): Promise<OmniNote | null> {
    const update: any = { content };
    if (isPrivate !== undefined) {
      update.isPrivate = isPrivate;
    }
    return this.noteRepo.update(noteId, update);
  }

  /**
   * Delete a note.
   */
  async deleteNote(noteId: string): Promise<boolean> {
    return this.noteRepo.delete(noteId);
  }
}
