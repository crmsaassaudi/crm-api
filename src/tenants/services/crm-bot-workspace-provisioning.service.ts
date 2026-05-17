import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

type ProvisionWorkspaceInput = {
  tenantId: string;
  ownerEmail: string;
  ownerName: string;
  tenantName: string;
};

type ProvisionWorkspaceResponse = {
  ok: true;
  workspaceId: string;
};

@Injectable()
export class CrmBotWorkspaceProvisioningService {
  private readonly logger = new Logger(CrmBotWorkspaceProvisioningService.name);

  constructor(private readonly configService: ConfigService) {}

  async provisionWorkspace(input: ProvisionWorkspaceInput): Promise<string> {
    const baseUrl = this.resolveBuilderBaseUrl();
    const internalSecret = this.resolveInternalSecret();
    const endpoint = `${baseUrl}/api/internal/workspaces/provision`;

    const response = await axios.post<ProvisionWorkspaceResponse>(
      endpoint,
      {
        tenantId: input.tenantId,
        ownerEmail: input.ownerEmail,
        ownerName: input.ownerName,
        tenantName: input.tenantName,
      },
      {
        timeout: this.resolveTimeoutMs(),
        headers: {
          'content-type': 'application/json',
          'x-crm-internal-secret': internalSecret,
        },
      },
    );

    if (!response.data?.ok || !response.data.workspaceId) {
      throw new Error(
        'crm-bot workspace provisioning returned an invalid response',
      );
    }

    this.logger.log(
      `Provisioned crm-bot workspace ${response.data.workspaceId} for tenant ${input.tenantId}`,
    );

    return response.data.workspaceId;
  }

  private resolveBuilderBaseUrl(): string {
    const raw =
      this.configService.get<string>('CRM_BOT_BUILDER_URL', { infer: true }) ||
      this.configService.get<string>('CRM_BOT_URL', { infer: true }) ||
      'http://localhost:4202';
    return raw.replace(/\/+$/, '');
  }

  private resolveInternalSecret(): string {
    const secret = this.configService.get<string>('CRM_BOT_INTERNAL_SECRET', {
      infer: true,
    });
    if (!secret) {
      throw new Error('CRM_BOT_INTERNAL_SECRET is required');
    }
    return secret;
  }

  private resolveTimeoutMs(): number {
    const raw =
      this.configService.get<string>('CRM_BOT_PROVISION_TIMEOUT_MS', {
        infer: true,
      }) ||
      this.configService.get<string>('CRM_BOT_TIMEOUT_MS', { infer: true });
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
  }
}
