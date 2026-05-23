import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OmniGateway } from '../../omni-inbound/services/omni.gateway';

/**
 * Listens for contact export completion events and pushes the result
 * to the tenant room via WebSocket (`/omni` namespace) so the frontend
 * can trigger download immediately instead of polling the export-status API.
 *
 * Socket event: `contact:export:completed`
 * Room: `tenant:{tenantId}` (broadcast to all connected agents of the tenant)
 *
 * The frontend filters by `userId` to show notification only to the user
 * who triggered the export.
 */
@Injectable()
export class ContactExportNotificationListener {
  private readonly logger = new Logger(
    ContactExportNotificationListener.name,
  );

  constructor(private readonly omniGateway: OmniGateway) {}

  @OnEvent('contact.export.completed')
  handleExportCompleted(event: {
    tenantId: string;
    userId: string;
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
    storageKey: string;
  }) {
    if (!event.tenantId) {
      this.logger.warn(
        'Contact export completed but no tenantId — cannot push via socket',
      );
      return;
    }

    const room = `tenant:${event.tenantId}`;
    this.omniGateway.server?.to(room).emit('contact:export:completed', {
      userId: event.userId,
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });

    this.logger.log(
      `Pushed export result to room ${room} (user=${event.userId}): ${event.recordCount} records`,
    );
  }
}
