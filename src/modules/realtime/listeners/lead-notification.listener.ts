import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SalesGateway } from '../gateways/sales.gateway';
import { LeadCreatedEvent } from '../events/lead-created.event';
import { LeadStatusUpdatedEvent } from '../events/lead-status-updated.event';
import { NotificationPayload } from '../dto/notification.payload';

@Injectable()
export class LeadNotificationListener {
  private readonly logger = new Logger(LeadNotificationListener.name);

  constructor(private readonly salesGateway: SalesGateway) {}

  @OnEvent('lead.created')
  handleLeadCreatedEvent(event: LeadCreatedEvent) {
    this.logger.log(`Handling lead.created event for lead ${event.leadId}`);

    const payload = new NotificationPayload(
      'lead_created',
      `New lead assigned: ${event.name}`,
      event.leadId,
    );

    this.salesGateway.emitToSale(event.saleId, 'notification', payload);
  }

  @OnEvent('lead.status.updated')
  handleLeadStatusUpdatedEvent(event: LeadStatusUpdatedEvent) {
    this.logger.log(
      `Handling lead.status.updated event for lead ${event.leadId}`,
    );

    const payload = new NotificationPayload(
      'lead_status_updated',
      `Lead status updated to ${event.status}`,
      event.leadId,
    );

    this.salesGateway.emitToSale(event.saleId, 'notification', payload);
  }
}
