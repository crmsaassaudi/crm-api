import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { DataVisibilityInterceptor } from '../../data-visibility/data-visibility.interceptor';
import {
  ExecutionPrincipal,
  systemPrincipal,
} from '../domain/execution-principal';

@Injectable()
export class ExecutionContextService {
  private readonly logger = new Logger(ExecutionContextService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly dataVisibility: DataVisibilityInterceptor,
  ) {}

  async runAs<T>(
    principal: ExecutionPrincipal | undefined,
    workflowId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const effective = principal ?? systemPrincipal(workflowId);

    this.cls.set('executionSource', 'A_F');
    this.cls.set('sourceContext', {
      flowId: workflowId,
      runAs: effective.runAs,
      principalId: effective.userId ?? 'system',
    });
    this.cls.set(
      'principalType',
      effective.kind === 'user' ? 'user' : 'system',
    );
    this.cls.set('principalId', effective.userId ?? 'system');

    if (effective.kind === 'user' && effective.userId) {
      this.cls.set('userId', effective.userId);
      await this.dataVisibility.resolveVisibility();

      this.logger.debug(
        `[ExecutionContext] Running as user=${effective.userId} ` +
          `(runAs=${effective.runAs}) scope=${describeScope(
            this.cls.get('visibleOwnerIds'),
          )}`,
      );
    } else {
      this.cls.set('userId', undefined);
      this.cls.set('visibleOwnerIds', null);
      this.cls.set('visibleOrgUnitIds', null);
      this.cls.set('servableChannelIds', null);
      this.cls.set('dataVisibilityByModule', {});

      if (effective.fallbackReason) {
        this.logger.warn(
          `[ExecutionContext] runAs=${effective.runAs} fell back to the system ` +
            `principal for workflow ${workflowId}: ${effective.fallbackReason}`,
        );
      }
    }

    return work();
  }
}

function describeScope(visibleOwnerIds: unknown): string {
  if (visibleOwnerIds === null) return 'all';
  if (Array.isArray(visibleOwnerIds))
    return `${visibleOwnerIds.length} owner(s)`;
  return 'unresolved';
}
