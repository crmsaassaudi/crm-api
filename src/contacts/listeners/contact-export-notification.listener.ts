import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SalesGateway } from '../../modules/realtime/gateways/sales.gateway';

/**
 * Listens for contact export completion events and pushes the result
 * to the user via WebSocket so the frontend can trigger download
 * immediately instead of polling the export-status API.
 *
 * Socket event: `contact:export:completed`
 * Room: `sale:{userId}` (the user who triggered the export)
 */
@Injectable()
export class ContactExportNotificationListener {
  private readonly logger = new Logger(
    ContactExportNotificationListener.name,
  );

  constructor(private readonly salesGateway: SalesGateway) {}

  @OnEvent('contact.export.completed')
  handleExportCompleted(event: {
    tenantId: string;
    userId: string;
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
    storageKey: string;
  }) {
    if (!event.userId) {
      this.logger.warn(
        'Contact export completed but no userId — cannot push via socket',
      );
      return;
    }

    this.salesGateway.emitToSale(event.userId, 'contact:export:completed', {
      downloadUrl: event.downloadUrl,
      expiresAt: event.expiresAt,
      recordCount: event.recordCount,
    });

    this.logger.log(
      `Pushed export result to user ${event.userId}: ${event.recordCount} records, url=${event.downloadUrl}`,
    );
  }
}
