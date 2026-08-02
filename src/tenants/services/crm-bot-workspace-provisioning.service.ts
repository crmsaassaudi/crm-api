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

type DeprovisionWorkspaceResponse = {
  ok: boolean;
  deleted?: boolean;
  reason?: string;
  error?: string;
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

  /**
   * Undo `provisionWorkspace` for a tenant that never finished provisioning.
   *
   * The saga creates the bot workspace at step 8 and can still fail at 9 or 10.
   * Without this the workspace, its welcome bot and its member row outlived the
   * tenant they belonged to, unreachable and uncountable — a slow leak in a
   * database the CRM does not own.
   *
   * crm-bot declines the delete if anyone has used the workspace; that comes
   * back as `deleted: false` with a reason, not as an error. Returns false
   * rather than throwing on transport failures too: a rollback that throws
   * would mask the original provisioning error.
   */
  async deprovisionWorkspace(tenantId: string): Promise<boolean> {
    const baseUrl = this.resolveBuilderBaseUrl();
    const endpoint = `${baseUrl}/api/internal/workspaces/deprovision`;

    try {
      const response = await axios.post<DeprovisionWorkspaceResponse>(
        endpoint,
        { tenantId },
        {
          timeout: this.resolveTimeoutMs(),
          headers: {
            'content-type': 'application/json',
            'x-crm-internal-secret': this.resolveInternalSecret(),
          },
        },
      );

      if (response.data?.deleted) {
        this.logger.log(
          `Deprovisioned crm-bot workspace for tenant ${tenantId}`,
        );
        return true;
      }

      this.logger.warn(
        `crm-bot kept the workspace for tenant ${tenantId}: ${response.data?.reason ?? 'unknown reason'}`,
      );
      return false;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to deprovision crm-bot workspace for tenant ${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private resolveBuilderBaseUrl(): string {
    const raw =
      this.configService.get<string>('CRM_BOT_BUILDER_URL', { infer: true }) ??
      this.configService.get<string>('CRM_BOT_URL', { infer: true }) ??
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
      }) ??
      this.configService.get<string>('CRM_BOT_TIMEOUT_MS', { infer: true });
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
  }
}
