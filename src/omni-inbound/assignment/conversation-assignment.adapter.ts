import { Injectable } from '@nestjs/common';
import { AssignmentAdapter } from '../../assignment/core/ports';
import { AssignmentObjectType } from '../../assignment/domain/assignment.types';
import { ConversationCandidatePort } from './conversation-candidate.port';
import { ConversationLoadPort } from './conversation-load.port';
import { ConversationCommitPort } from './conversation-commit.port';

/**
 * The adapter for omni conversations.
 *
 * Registered late — `OmniInboundModule` calls
 * `AssignmentCoreService.registerAdapter()` on init — because it depends on
 * presence, channel support and the conversation repository. A static edge from
 * the core module to those would put a queue-owning module inside the import
 * cycle the core exists to stay out of.
 */
@Injectable()
export class ConversationAssignmentAdapter implements AssignmentAdapter {
  readonly objectTypes: readonly AssignmentObjectType[] = ['Conversation'];

  constructor(
    readonly candidates: ConversationCandidatePort,
    readonly load: ConversationLoadPort,
    readonly commit: ConversationCommitPort,
  ) {}
}
