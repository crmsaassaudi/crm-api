import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { DataVisibilityInterceptor } from '../../data-visibility/data-visibility.interceptor';
import {
  ExecutionPrincipal,
  systemPrincipal,
} from '../domain/execution-principal';

/**
 * Establishes the authorization context an automation runs under.
 *
 * Every authorization layer in this platform reads CLS and is populated by an
 * HTTP interceptor — `DataVisibilityInterceptor` sets `visibleOwnerIds`,
 * `visibleOrgUnitIds`, `dataVisibilityByModule`, `servableChannelIds`;
 * `PermissionGuard` sets `abacResourceFilter`. A BullMQ consumer traverses
 * neither, and `DocumentRepositoryAbstract.applyTenantFilter` treats an absent
 * `visibleOwnerIds` as "no filter". So automation reads and writes were
 * tenant-wide no matter who built the workflow.
 *
 * This service closes that by resolving the SAME visibility computation the
 * interceptor uses, for the principal the workflow declared.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — findings C4, M4
 */
@Injectable()
export class ExecutionContextService {
  private readonly logger = new Logger(ExecutionContextService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly dataVisibility: DataVisibilityInterceptor,
  ) {}

  /**
   * Populate CLS for `principal` and run `work` inside it.
   *
   * Assumes the caller has already established `tenantId` / `activeTenantId`
   * (BaseTenantConsumer does).
   */
  async runAs<T>(
    principal: ExecutionPrincipal | undefined,
    workflowId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const effective = principal ?? systemPrincipal(workflowId);

    // Audit attribution: `A_F` marks the write as automation-sourced, and the
    // principal tells a reader on whose authority it happened.
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
      // A real user: `userId` drives both the repository's createdById /
      // updatedById enrichment and the visibility resolution below, so the
      // automation is scoped exactly as that user would be.
      this.cls.set('userId', effective.userId);
      await this.dataVisibility.resolveVisibility();

      this.logger.debug(
        `[ExecutionContext] Running as user=${effective.userId} ` +
          `(runAs=${effective.runAs}) scope=${describeScope(
            this.cls.get('visibleOwnerIds'),
          )}`,
      );
    } else {
      // The system principal. Set the axes to `null` — the interceptor's
      // explicit "see everything" value — rather than leaving them undefined.
      // Same effective breadth, but now it is a decision recorded in CLS rather
      // than the accidental result of a key nobody set.
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
