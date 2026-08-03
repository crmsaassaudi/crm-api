import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { BaseConsumer } from './base.consumer';

/**
 * Standard job data interface for ALL tenant-scoped BullMQ jobs.
 * Every queue that operates within a tenant MUST include these fields.
 */
export interface TenantJobData {
  tenantId: string;
  userId?: string;
  /**
   * Row-level visibility captured from the request that enqueued this job.
   *
   * Restored into CLS before `handle()` runs, so a repository call inside a
   * worker narrows exactly as it would have inside the request. Optional because
   * many jobs are legitimately tenant-wide (retention purge, reconciliation) and
   * must keep reading everything; a job that represents *a user's* read has to
   * supply it, and `ExportRequestService` now does so unconditionally.
   */
  scope?: object;
}

/**
 * Base class for ALL tenant-scoped BullMQ processors.
 *
 * Convention:
 *   1. Extend this class instead of BaseConsumer / WorkerHost
 *   2. Implement handle(job) instead of process(job)
 *   3. Job data type must extend TenantJobData
 *
 * Guarantees:
 *   - CLS store is initialized with tenantId + activeTenantId + userId
 *     BEFORE handle() runs
 *   - Mongoose tenant-filter plugin will always find activeTenantId
 *   - Fail-fast if tenantId is missing from job data
 *
 * Example:
 * ```ts
 * @Processor('my-queue')
 * class MyProcessor extends BaseTenantConsumer<MyJobData> {
 *   protected readonly cls: ClsService;
 *   constructor(cls: ClsService, private svc: MyService) {
 *     super();
 *     this.cls = cls;
 *   }
 *   protected async handle(job: Job<MyJobData>) {
 *     // CLS already has tenantId — just write business logic
 *     return this.svc.doWork(job.data);
 *   }
 * }
 * ```
 */
export abstract class BaseTenantConsumer<
  TData extends TenantJobData = TenantJobData,
  TResult = any,
> extends BaseConsumer {
  /** Subclasses MUST assign their injected ClsService to this field. */
  protected abstract readonly cls: ClsService;

  /**
   * Sealed entry point — do NOT override in subclasses.
   * Sets up tenant CLS context, then delegates to handle().
   */
  async process(job: Job<TData>): Promise<TResult> {
    const { tenantId, userId, scope } = job.data;

    if (!tenantId) {
      throw new Error(
        `[${this.constructor.name}] Job ${job.id} is missing tenantId. ` +
          'All tenant-scoped jobs MUST include tenantId in job data.',
      );
    }

    return this.cls.runWith(
      {
        tenantId,
        activeTenantId: tenantId,
        // Restored BEFORE handle(), because a repository reads these the moment
        // it builds its first filter. Setting them afterwards, or inside the
        // handler, is too late for anything the handler's first query returns.
        //
        // Until this existed the CLS store held only the tenant, and
        // `applyTenantFilter` reads `visibleOwnerIds === undefined` as "no owner
        // predicate" — so every user-initiated read performed in a worker
        // silently widened to the whole tenant.
        ...(scope ?? {}),
      } as any,
      async () => {
        if (userId) {
          this.cls.set('userId', userId);
        }

        this.logger.debug(
          `[tenant=${tenantId}] Processing job ${job.id} (${job.name})`,
        );

        return this.handle(job);
      },
    );
  }

  /**
   * Implement business logic here.
   * CLS is guaranteed to have tenantId + activeTenantId (+ userId if present).
   */
  protected abstract handle(job: Job<TData>): Promise<TResult>;
}
