import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

/**
 * CrmRealtimeGateway — handles CRM-specific real-time events.
 *
 * Responsibilities:
 * - Contact/Account/Deal/Ticket export completion broadcasts
 * - Contact/Account/Deal/Ticket import completion broadcasts
 *
 * These events are CRM module concerns, NOT omni-channel messaging.
 * Extracted from OmniGateway (1,700+ lines) to:
 * - Reduce cognitive load — OmniGateway should only handle omni messaging
 * - Allow independent evolution of CRM vs Omni real-time events
 * - Improve readability and maintainability
 *
 * Design: Plain @Injectable() service, receives Socket.IO Server reference
 * from OmniGateway via setServer(). Shares the same /omni namespace.
 */
@Injectable()
export class CrmRealtimeGateway {
  private readonly logger = new Logger(CrmRealtimeGateway.name);
  private server!: Server;

  /**
   * Called by OmniGateway.onModuleInit() to share the Socket.IO server reference.
   */
  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * Redis pub/sub channel names this service handles.
   */
  static readonly REDIS_CHANNELS = [
    'socket:contact:export:completed',
    'socket:account:export:completed',
    'socket:deal:export:completed',
    'socket:ticket:export:completed',
    'socket:contact:import:completed',
    'socket:account:import:completed',
    'socket:deal:import:completed',
    'socket:ticket:import:completed',
  ] as const;

  /**
   * Route a Redis pub/sub message to the appropriate handler.
   * Called by OmniGateway's Redis subscriber.
   */
  handleRedisMessage(channel: string, event: any): boolean {
    switch (channel) {
      case 'socket:contact:export:completed':
        this.handleContactExportCompleted(event);
        return true;
      case 'socket:account:export:completed':
        this.handleModuleExportCompleted('account', event);
        return true;
      case 'socket:deal:export:completed':
        this.handleModuleExportCompleted('deal', event);
        return true;
      case 'socket:ticket:export:completed':
        this.handleModuleExportCompleted('ticket', event);
        return true;
      case 'socket:contact:import:completed':
        this.handleContactImportCompleted(event);
        return true;
      case 'socket:account:import:completed':
        this.handleModuleImportCompleted('account', event);
        return true;
      case 'socket:deal:import:completed':
        this.handleModuleImportCompleted('deal', event);
        return true;
      case 'socket:ticket:import:completed':
        this.handleModuleImportCompleted('ticket', event);
        return true;
      default:
        return false;
    }
  }

  // ─── Export handlers ─────────────────────────────────────────────

  /**
   * Broadcast contact export completion to the tenant room.
   */
  private handleContactExportCompleted(event: {
    tenantId: string;
    userId: string;
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
  }) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting contact export completed to room=${room} (user=${event.userId}, records=${event.recordCount})`,
    );
    this.server.to(room).emit('contact:export:completed', {
      userId: event.userId,
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });
  }

  /**
   * Generic handler for account/deal/ticket export completion events.
   */
  private handleModuleExportCompleted(
    module: 'account' | 'deal' | 'ticket',
    event: {
      tenantId: string;
      userId: string;
      downloadUrl: string;
      expiresAt: string;
      recordCount: number;
    },
  ) {
    const room = `tenant:${event.tenantId}`;
    this.logger.log(
      `Broadcasting ${module} export completed to room=${room} (user=${event.userId}, records=${event.recordCount})`,
    );
    this.server.to(room).emit(`${module}:export:completed`, {
      userId: event.userId,
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });
  }

  // ─── Import handlers ─────────────────────────────────────────────

  /**
   * Broadcast contact import completion to the user who triggered it.
   * Unlike export (tenant-wide), import results are only meaningful to the
   * initiating user, so we emit to the `agent:${userId}` room.
   */
  private handleContactImportCompleted(event: {
    tenantId: string;
    userId: string;
    jobId: string;
    fileName?: string;
    summary: {
      total: number;
      inserted: number;
      updated: number;
      skipped: number;
      errors: number;
    };
    reportUrl?: string;
  }) {
    const room = `agent:${event.userId}`;
    this.logger.log(
      `Broadcasting contact import completed to room=${room}, jobId=${event.jobId}`,
    );
    this.server.to(room).emit('contact:import:completed', {
      jobId: event.jobId,
      fileName: event.fileName,
      summary: event.summary,
      reportUrl: event.reportUrl,
    });
  }

  /**
   * Generic handler for account/deal/ticket import completion events.
   * Emits to the agent:${userId} room with module-prefixed event name.
   */
  private handleModuleImportCompleted(
    module: 'account' | 'deal' | 'ticket',
    event: {
      tenantId: string;
      userId: string;
      jobId: string;
      fileName?: string;
      summary: {
        total: number;
        inserted: number;
        updated: number;
        skipped: number;
        errors: number;
      };
      reportUrl?: string;
    },
  ) {
    const room = `agent:${event.userId}`;
    this.logger.log(
      `Broadcasting ${module} import completed to room=${room}, jobId=${event.jobId}`,
    );
    this.server.to(room).emit(`${module}:import:completed`, {
      jobId: event.jobId,
      fileName: event.fileName,
      summary: event.summary,
      reportUrl: event.reportUrl,
    });
  }
}
