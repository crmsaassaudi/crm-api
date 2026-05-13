import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CRYPTO_SERVICE_TOKEN,
  ICryptoService,
} from '../../channels/domain/crypto.service';
import { WorkflowNode } from '../infrastructure/persistence/document/entities/automation-workflow.schema';

const ENCRYPTED_HEADER_PREFIX = 'enc:v1:';
const REDACTED_HEADER_VALUE = '[redacted]';

type HeaderMap = Record<string, unknown>;
type HeaderArrayItem = {
  key?: unknown;
  value?: unknown;
  [key: string]: unknown;
};

interface NodeTransformResult {
  nodes: WorkflowNode[];
  changed: boolean;
}

interface ConfigTransformResult {
  config: Record<string, any>;
  changed: boolean;
}

@Injectable()
export class WebhookHeaderCryptoService {
  private readonly logger = new Logger(WebhookHeaderCryptoService.name);

  constructor(
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
  ) {}

  isEncryptedValue(value: unknown): value is string {
    return (
      typeof value === 'string' && value.startsWith(ENCRYPTED_HEADER_PREFIX)
    );
  }

  async encryptNodes(nodes: WorkflowNode[] = []): Promise<NodeTransformResult> {
    let changed = false;
    const encryptedNodes = await Promise.all(
      nodes.map(async (node) => {
        if (!this.isWebhookActionNode(node)) return cloneJson(node);

        const result = await this.encryptWebhookConfig(node.config || {});
        if (result.changed) changed = true;

        return {
          ...cloneJson(node),
          config: result.config,
        };
      }),
    );

    return { nodes: encryptedNodes, changed };
  }

  async decryptNodesForResponse(
    nodes: WorkflowNode[] = [],
  ): Promise<WorkflowNode[]> {
    return Promise.all(
      nodes.map(async (node) => {
        if (!this.isWebhookActionNode(node)) return cloneJson(node);

        return {
          ...cloneJson(node),
          config: await this.decryptWebhookConfigForResponse(node.config || {}),
        };
      }),
    );
  }

  async encryptWebhookConfig(
    config: Record<string, any>,
  ): Promise<ConfigTransformResult> {
    const nextConfig = cloneJson(config);
    let changed = false;

    const headersResult = await this.encryptHeaderMap(nextConfig.headers);
    if (headersResult.changed) {
      nextConfig.headers = headersResult.headers;
      changed = true;
    }

    const headersArrayResult = await this.encryptHeadersArray(
      nextConfig.headersArray,
    );
    if (headersArrayResult.changed) {
      nextConfig.headersArray = headersArrayResult.headersArray;
      changed = true;
    }

    return { config: nextConfig, changed };
  }

  async resolveHeadersForExecution(
    config: Record<string, any>,
  ): Promise<Record<string, string>> {
    const rawHeaders = isHeaderMap(config.headers)
      ? config.headers
      : this.headerArrayToMap(config.headersArray);

    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (!key.trim() || value === undefined || value === null) continue;
      resolved[key] = await this.decryptHeaderValueStrict(value);
    }

    return resolved;
  }

  async decryptWebhookConfigForResponse(
    config: Record<string, any>,
  ): Promise<Record<string, any>> {
    const nextConfig = cloneJson(config);

    if (isHeaderMap(nextConfig.headers)) {
      nextConfig.headers = await this.decryptHeaderMapLenient(
        nextConfig.headers,
      );
    }

    if (Array.isArray(nextConfig.headersArray)) {
      nextConfig.headersArray = await this.decryptHeadersArrayLenient(
        nextConfig.headersArray,
      );
    } else if (isHeaderMap(nextConfig.headers)) {
      nextConfig.headersArray = Object.entries(nextConfig.headers).map(
        ([key, value]) => ({ key, value }),
      );
    }

    return nextConfig;
  }

  redactNodes(nodes: WorkflowNode[] = []): WorkflowNode[] {
    return nodes.map((node) => {
      if (!this.isWebhookActionNode(node)) return cloneJson(node);
      return {
        ...cloneJson(node),
        config: this.redactWebhookConfig(node.config || {}),
      };
    });
  }

  redactWebhookConfig(config: Record<string, any>): Record<string, any> {
    const nextConfig = cloneJson(config);

    if (isHeaderMap(nextConfig.headers)) {
      nextConfig.headers = Object.fromEntries(
        Object.keys(nextConfig.headers).map((key) => [
          key,
          REDACTED_HEADER_VALUE,
        ]),
      );
    }

    if (Array.isArray(nextConfig.headersArray)) {
      nextConfig.headersArray = nextConfig.headersArray.map((item) => ({
        ...item,
        value: item?.key ? REDACTED_HEADER_VALUE : item?.value,
      }));
    }

    return nextConfig;
  }

  private isWebhookActionNode(node: WorkflowNode): boolean {
    return node.type === 'action' && node.config?.actionType === 'webhook';
  }

  private async encryptHeaderMap(
    headers: unknown,
  ): Promise<{ headers: HeaderMap; changed: boolean }> {
    if (!isHeaderMap(headers)) return { headers: {}, changed: false };

    let changed = false;
    const encryptedEntries = await Promise.all(
      Object.entries(headers).map(async ([key, value]) => {
        const encryptedValue = await this.encryptHeaderValue(value);
        if (encryptedValue !== value) changed = true;
        return [key, encryptedValue] as const;
      }),
    );

    return {
      headers: Object.fromEntries(encryptedEntries),
      changed,
    };
  }

  private async encryptHeadersArray(
    headersArray: unknown,
  ): Promise<{ headersArray: HeaderArrayItem[]; changed: boolean }> {
    if (!Array.isArray(headersArray)) {
      return { headersArray: [], changed: false };
    }

    let changed = false;
    const encryptedArray = await Promise.all(
      headersArray.map(async (item) => {
        if (!isHeaderArrayItem(item)) return item as HeaderArrayItem;
        const encryptedValue = await this.encryptHeaderValue(item.value);
        if (encryptedValue !== item.value) changed = true;
        return { ...item, value: encryptedValue };
      }),
    );

    return { headersArray: encryptedArray, changed };
  }

  private async encryptHeaderValue(value: unknown): Promise<unknown> {
    if (typeof value !== 'string' || value.length === 0) return value;
    if (this.isEncryptedValue(value)) return value;
    return `${ENCRYPTED_HEADER_PREFIX}${await this.crypto.encrypt(value)}`;
  }

  private async decryptHeaderMapLenient(
    headers: HeaderMap,
  ): Promise<Record<string, string>> {
    const entries = await Promise.all(
      Object.entries(headers).map(async ([key, value]) => [
        key,
        await this.decryptHeaderValueLenient(value),
      ]),
    );

    return Object.fromEntries(entries);
  }

  private async decryptHeadersArrayLenient(
    headersArray: HeaderArrayItem[],
  ): Promise<HeaderArrayItem[]> {
    return Promise.all(
      headersArray.map(async (item) => ({
        ...item,
        value: await this.decryptHeaderValueLenient(item.value),
      })),
    );
  }

  private async decryptHeaderValueStrict(value: unknown): Promise<string> {
    if (this.isEncryptedValue(value)) {
      return this.crypto.decrypt(value.slice(ENCRYPTED_HEADER_PREFIX.length));
    }

    if (value === undefined || value === null) return '';
    return String(value);
  }

  private async decryptHeaderValueLenient(value: unknown): Promise<string> {
    try {
      return await this.decryptHeaderValueStrict(value);
    } catch (error: any) {
      this.logger.warn(
        `Failed to decrypt webhook header value for API response: ${error.message}`,
      );
      return REDACTED_HEADER_VALUE;
    }
  }

  private headerArrayToMap(headersArray: unknown): HeaderMap {
    if (!Array.isArray(headersArray)) return {};

    return headersArray.reduce<HeaderMap>((acc, item) => {
      if (!isHeaderArrayItem(item) || typeof item.key !== 'string') return acc;
      if (!item.key.trim()) return acc;
      acc[item.key.trim()] = item.value;
      return acc;
    }, {});
  }
}

function isHeaderMap(value: unknown): value is HeaderMap {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) =>
        entry === undefined ||
        entry === null ||
        ['string', 'number', 'boolean'].includes(typeof entry),
    )
  );
}

function isHeaderArrayItem(value: unknown): value is HeaderArrayItem {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
