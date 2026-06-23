import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { TimelineQueryDto } from '../dto/timeline-query.dto';
import { TimelineResponseDto } from '../dto/timeline-response.dto';
import {
  ThreadIdentity,
  ThreadSessionSlice,
} from '../repositories/conversation.repository';

/**
 * ConversationQueryService — read-only queries for conversation data.
 *
 * Extracted from ConversationService to:
 * - Separate read-path (queries) from write-path (inbound processing)
 * - Allow independent scaling of query-heavy endpoints
 * - Reduce ConversationService constructor dependency count
 */
@Injectable()
export class ConversationQueryService {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
  ) {}

  /**
   * Get the conversation timeline for a customer thread.
   *
   * Returns the anchor session (current conversation) plus past and future
   * sessions in the same thread, each with their messages.
   */
  async getConversationTimeline(params: {
    tenantId: string;
    conversationId: string;
    query: TimelineQueryDto;
  }): Promise<TimelineResponseDto> {
    const conversation = await this.conversationRepo.findById(
      params.conversationId,
    );
    if (!conversation || conversation.tenantId !== params.tenantId) {
      throw new NotFoundException(
        `Conversation ${params.conversationId} not found`,
      );
    }

    const sessionLimit = this.parsePositiveInt(
      params.query.sessionLimit,
      5,
      20,
    );
    const messageLimit = this.parsePositiveInt(
      params.query.messageLimit,
      50,
      100,
    );

    const thread: ThreadIdentity = {
      tenantId: conversation.tenantId,
      channelType: conversation.channelType,
      channelAccount: conversation.channelAccount,
      externalId: conversation.externalConversationId,
    };

    const anchorCursor = {
      createdAt: conversation.createdAt,
      id: conversation.id,
    };

    const pastCursor = this.parseCursor(
      params.query.pastCursorCreatedAt,
      params.query.pastCursorId,
    );
    const futureCursor = this.parseCursor(
      params.query.futureCursorCreatedAt,
      params.query.futureCursorId,
    );

    let past: ThreadSessionSlice = {
      sessions: [],
      hasMore: false,
      cursor: null,
    };
    let future: ThreadSessionSlice = {
      sessions: [],
      hasMore: false,
      cursor: null,
    };

    if (!pastCursor && !futureCursor) {
      const around = await this.conversationRepo.findThreadSessionsAroundAnchor(
        {
          thread,
          anchor: anchorCursor,
          pastLimit: sessionLimit,
          futureLimit: sessionLimit,
        },
      );
      past = around.past;
      future = around.future;
    } else {
      if (pastCursor) {
        past = await this.conversationRepo.findPastSessionsByCursor({
          ...thread,
          cursor: pastCursor,
          limit: sessionLimit,
        });
      }
      if (futureCursor) {
        future = await this.conversationRepo.findFutureSessionsByCursor({
          ...thread,
          cursor: futureCursor,
          limit: sessionLimit,
        });
      }
    }

    const timelineSessions = [
      ...past.sessions,
      conversation,
      ...future.sessions,
    ];

    const messageMap =
      await this.messageRepo.findByConversationIdsChronological(
        timelineSessions.map((session) => session.id),
        messageLimit,
      );

    const toSessionBlock = (session: any) => {
      const fullName = session.resolvedByAgent
        ? [session.resolvedByAgent.firstName, session.resolvedByAgent.lastName]
            .filter(Boolean)
            .join(' ')
            .trim() || null
        : null;

      const sessionMessages = messageMap[session.id] ?? [];
      const lastMessage = sessionMessages[sessionMessages.length - 1] ?? null;

      return {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        resolvedAt: session.resolvedAt,
        resolvedByAgentId: session.resolvedByAgentId,
        resolvedByAgentName: fullName,
        resolvedByAgentEmail: session.resolvedByAgent?.email ?? null,
        resolveReason: session.resolveReason,
        resolveNote: session.resolveNote,
        resolveSource: session.resolveSource,
        lastMessage: session.lastMessage,
        messages: {
          data: sessionMessages,
          hasMore: sessionMessages.length >= messageLimit,
          cursor: lastMessage
            ? {
                createdAt: lastMessage.createdAt,
                id: lastMessage.id,
              }
            : null,
        },
      };
    };

    return {
      pastSessions: past.sessions.map(toSessionBlock),
      anchorSession: toSessionBlock(conversation),
      futureSessions: future.sessions.map(toSessionBlock),
      hasMorePast: past.hasMore,
      hasMoreFuture: future.hasMore,
      pastCursor: past.cursor,
      futureCursor: future.cursor,
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────

  parsePositiveInt(
    value: string | undefined,
    fallback: number,
    max: number,
  ): number {
    const parsed = Number.parseInt(value ?? `${fallback}`, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.min(parsed, max);
  }

  parseCursor(
    createdAt?: string,
    id?: string,
  ): { createdAt: Date; id: string } | null {
    if (!createdAt && !id) {
      return null;
    }
    if (!createdAt || !id) {
      throw new BadRequestException('Cursor requires both createdAt and id');
    }

    const parsedDate = new Date(createdAt);
    if (Number.isNaN(parsedDate.getTime())) {
      throw new BadRequestException(
        'Cursor createdAt must be a valid ISO date',
      );
    }

    return { createdAt: parsedDate, id };
  }
}
