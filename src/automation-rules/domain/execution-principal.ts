/**
 * Who an automation acts as.
 *
 * Before this existed, the answer was "nobody": `AutomationEventPayload` and
 * `AutomationActionJobData` carried only `tenantId`, `BaseTenantConsumer`
 * established only `{tenantId, activeTenantId}`, and every authorization layer in
 * the platform is CLS- and request-scoped — `PermissionGuard`, `AclGuard`,
 * `DataVisibilityInterceptor`, and the `visibleOwnerIds`/`abacResourceFilter`
 * checks in `DocumentRepositoryAbstract.applyTenantFilter`, which skip entirely
 * when their CLS keys are absent. So an executing workflow read and wrote every
 * record in its tenant regardless of who built it, and `cls.set('executionSource',
 * 'A_F')` was a label on the audit row rather than an identity.
 *
 * A principal travels with the event and the job so the worker can rebuild the
 * same authorization context an HTTP request would have had.
 *
 * @see docs/audit/WORKFLOW_AUTOMATION_SECURITY_AUDIT.md — finding C4
 */

/**
 * How a workflow chooses its principal. Stored on the workflow, resolved per
 * execution.
 */
export type WorkflowRunAs =
  /**
   * Full tenant scope, no user. What every workflow did implicitly before this
   * existed, and still the only option for a workflow whose actions must reach
   * records nobody in particular owns. Gated on
   * `automation_workflows:run_as_system`.
   */
  | 'system'
  /**
   * The user who published the workflow. The safe default: the automation can do
   * what its author could do, which is the principle of least surprise for
   * anyone reading the audit trail.
   */
  | 'creator'
  /**
   * The user whose action fired the trigger. Matches how a Zendesk trigger or a
   * HubSpot workflow attributes its work, and keeps a scoped user's automation
   * inside that user's scope.
   */
  | 'trigger_user'
  /** The record's owner at trigger time. */
  | 'record_owner';

export const WORKFLOW_RUN_AS_VALUES: readonly WorkflowRunAs[] = [
  'system',
  'creator',
  'trigger_user',
  'record_owner',
];

/**
 * The default for a workflow that does not say.
 *
 * `system` rather than `creator` on purpose: it is what every existing workflow
 * already does, and silently narrowing the scope of live automations during an
 * upgrade would break them in ways that look like data problems rather than
 * permission problems. New workflows should choose `creator`.
 */
export const DEFAULT_RUN_AS: WorkflowRunAs = 'system';

/**
 * The resolved actor for one execution.
 *
 * `userId` is null only for `kind: 'system'`. Everything else carries a real
 * tenant user whose roles and data-visibility scope the worker will apply.
 */
export interface ExecutionPrincipal {
  kind: 'system' | 'user';
  /** Mongo user id; null for the system principal. */
  userId: string | null;
  /** Which `runAs` produced this principal, for the audit trail. */
  runAs: WorkflowRunAs;
  /** The workflow that granted this principal its authority. */
  grantedByWorkflowId: string;
  /**
   * Set when the configured `runAs` could not be honoured and the execution fell
   * back — e.g. `trigger_user` on a cron-initiated event, which has no user.
   * Recorded rather than silently substituted.
   */
  fallbackReason?: string;
}

/** The system principal — full tenant scope, no user. */
export function systemPrincipal(
  workflowId: string,
  runAs: WorkflowRunAs = 'system',
  fallbackReason?: string,
): ExecutionPrincipal {
  return {
    kind: 'system',
    userId: null,
    runAs,
    grantedByWorkflowId: workflowId,
    fallbackReason,
  };
}

/** A principal bound to a real tenant user. */
export function userPrincipal(
  userId: string,
  runAs: WorkflowRunAs,
  workflowId: string,
): ExecutionPrincipal {
  return {
    kind: 'user',
    userId,
    runAs,
    grantedByWorkflowId: workflowId,
  };
}

/**
 * Resolve the principal for one execution.
 *
 * Explicit user-scoped modes fail closed when the identity cannot be resolved.
 * Otherwise a missing actor or owner would silently elevate the workflow to
 * tenant-wide system authority. Legacy workflows with no `runAs` remain
 * compatible because DEFAULT_RUN_AS is still `system`.
 */
export function resolvePrincipal(params: {
  runAs: WorkflowRunAs | undefined;
  workflowId: string;
  /** `createdBy` on the workflow. */
  workflowCreatedBy?: string | null;
  /** The user whose request emitted the trigger event, when there was one. */
  triggerUserId?: string | null;
  /** `ownerId` of the triggering record. */
  recordOwnerId?: string | null;
}): ExecutionPrincipal {
  const runAs = params.runAs ?? DEFAULT_RUN_AS;

  switch (runAs) {
    case 'creator': {
      const creator = normalizeUserId(params.workflowCreatedBy);
      if (!creator) {
        throw unresolvedPrincipal(
          runAs,
          params.workflowId,
          'workflow has no usable createdBy',
        );
      }
      return userPrincipal(creator, runAs, params.workflowId);
    }
    case 'trigger_user': {
      const triggerUser = normalizeUserId(params.triggerUserId);
      if (!triggerUser) {
        throw unresolvedPrincipal(
          runAs,
          params.workflowId,
          'trigger had no acting user',
        );
      }
      return userPrincipal(triggerUser, runAs, params.workflowId);
    }
    case 'record_owner': {
      const owner = normalizeUserId(params.recordOwnerId);
      if (!owner) {
        throw unresolvedPrincipal(
          runAs,
          params.workflowId,
          'triggering record is unowned',
        );
      }
      return userPrincipal(owner, runAs, params.workflowId);
    }
    case 'system':
    default:
      return systemPrincipal(params.workflowId, 'system');
  }
}

function unresolvedPrincipal(
  runAs: WorkflowRunAs,
  workflowId: string,
  reason: string,
): Error {
  return new Error(
    `AUTOMATION_PRINCIPAL_UNRESOLVED: runAs=${runAs} workflow=${workflowId}: ${reason}`,
  );
}

/**
 * `'system'` was the historical placeholder written into `createdBy` when the
 * actor could not be resolved (see finding H4), so it must not be mistaken for a
 * user id.
 */
function normalizeUserId(value?: string | null): string | null {
  if (!value || value === 'system') return null;
  return value;
}
