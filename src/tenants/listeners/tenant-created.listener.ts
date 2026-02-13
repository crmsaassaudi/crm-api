import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantCreatedEvent } from '../events/tenant-created.event';

@Injectable()
export class TenantCreatedListener {
    private readonly logger = new Logger(TenantCreatedListener.name);

    @OnEvent('tenant.created', { async: true })
    handleTenantCreatedEvent(event: TenantCreatedEvent) {
        this.logger.log(`Tenant created: ${event.companyName} (${event.tenantId}) with admin ${event.adminEmail}`);
        // Here we can trigger other side effects like sending a welcome email or seeding data
    }
}
