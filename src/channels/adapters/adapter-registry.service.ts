import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import {
  ConnectionAdapter,
  ConnectionVerifyResult,
} from './connection-adapter.interface';
import { SendGridAdapter } from './sendgrid.adapter';
import { TwilioAdapter } from './twilio.adapter';

/**
 * Adapter Registry — Routes verifyConnection calls to the correct provider adapter.
 *
 * New adapters are registered in the constructor. To add a provider:
 *   1. Create a new adapter implementing ConnectionAdapter
 *   2. Add it to the constructor's register() calls below
 */
@Injectable()
export class AdapterRegistryService {
  private readonly logger = new Logger(AdapterRegistryService.name);
  private readonly adapters = new Map<string, ConnectionAdapter>();

  constructor(sendgrid: SendGridAdapter, twilio: TwilioAdapter) {
    this.register(sendgrid);
    this.register(twilio);
    this.logger.log(
      `[AdapterRegistry] Registered ${this.adapters.size} adapters: ${[...this.adapters.keys()].join(', ')}`,
    );
  }

  private register(adapter: ConnectionAdapter): void {
    this.adapters.set(adapter.providerType, adapter);
  }

  /**
   * Verify connection for a given provider type.
   * Throws BadRequestException if the provider type has no adapter.
   */
  async verify(
    providerType: string,
    credentials: Record<string, any>,
    settings: Record<string, any>,
  ): Promise<ConnectionVerifyResult> {
    const adapter = this.adapters.get(providerType);
    if (!adapter) {
      throw new BadRequestException(
        `No connection adapter registered for provider type: ${providerType}`,
      );
    }
    return adapter.verifyConnection(credentials, settings);
  }
}
