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
   * If isPinned=true, previous pinned notes for this conversation are unpinned first.
   * Emits `omni.conversation.note_added` for audit trail + WebSocket.
   */
  async createNote(
    tenantId: string,
    conversationId: string,
    authorId: string,
    content: string,
    isPrivate = true,
    mentions: string[] = [],
    isPinned = false,
  ): Promise<OmniNote> {
    const note = await this.noteRepo.create({
      tenantId,
      conversationId,
      content,
      authorId,
      mentions,
      isPrivate,
      isPinned,
    } as any);

    // If this note is a Handover Note, unpin all others for this conversation
    if (isPinned) {
      await this.noteRepo.setPinnedNote(conversationId, note.id);
    }

    this.eventEmitter.emit('omni.conversation.note_added', {
      tenantId,
      conversationId,
      noteId: note.id,
      authorId,
      authorName: note.authorName,
      isPrivate,
      isPinned,
      content: content.substring(0, 100), // preview for activity log
    });

    this.logger.log(
      `Note ${note.id} added to conversation ${conversationId} by ${authorId}${isPinned ? ' [PINNED]' : ''}`,
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
   * Get the currently pinned Handover Note for a conversation (or null if none).
   */
  async getPinnedNote(conversationId: string): Promise<OmniNote | null> {
    return this.noteRepo.findPinnedByConversation(conversationId);
  }

  /**
   * Update an existing note (content, isPrivate, or isPinned).
   */
  async updateNote(
    noteId: string,
    content: string,
    isPrivate?: boolean,
    isPinned?: boolean,
  ): Promise<OmniNote | null> {
    const update: any = { content };
    if (isPrivate !== undefined) {
      update.isPrivate = isPrivate;
    }
    if (isPinned !== undefined) {
      update.isPinned = isPinned;
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
