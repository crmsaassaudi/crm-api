import { TenantJobData } from '../../../queue/base-tenant.consumer';

export type ExportFormat = 'csv' | 'xlsx';

/**
 * A single output column in an export file.
 * The shared engine reads `path` off each (lean) document, optionally masks it
 * using `maskKey`, then renders the cell via `format` (or a default formatter).
 */
export interface ExportColumn {
  /** Header text written as the first row. */
  header: string;
  /**
   * Dot-path of the source field on the document. The literal `'id'` is mapped
   * to the document's `_id`. Nested paths (e.g. `owner.name`) are supported.
   */
  path: string;
  /**
   * Field key used to look up masking config (defaults to `path`). Use when the
   * masking layout keys differ from the export path.
   */
  maskKey?: string;
  /**
   * Optional cell renderer. Receives the (already-masked) value plus the whole
   * document. When omitted, a default formatter is used (array → 'a; b',
   * Date → ISO, null/undefined → '').
   */
  format?: (value: unknown, doc: Record<string, any>) => string;
}

/**
 * Typed export filter — replaces the old untyped `{ ids?, filters? }` payload
 * and the `__restrictToOwner` / `__currentUserId` magic keys.
 *
 * NOTE: for backward-compatibility during the Phase-1 refactor, modules may
 * still translate this into their existing repository filter shape. New modules
 * should consume it directly.
 */
export interface ExportFilter {
  /** Explicit record IDs to export. When present, other filters are ignored. */
  ids?: string[];
  /** Free-text search. */
  search?: string;
  /** Module-specific lifecycle/stage filter. */
  lifecycleStage?: string;
  /** Restrict to records owned by `currentUserId`. */
  restrictToOwner?: boolean;
  /** The requesting user (used with `restrictToOwner`). */
  currentUserId?: string;
  /** Generic typed filter items: `{ id, value }`. */
  filters?: Array<{ id: string; value: unknown }>;
}

/**
 * The requester's row-level visibility, frozen at enqueue time.
 *
 * Every field here is a CLS key that `BaseDocumentRepository.applyTenantFilter`
 * reads to narrow a query. They are populated per-request by
 * `DataVisibilityInterceptor` and `PermissionGuard` — and a BullMQ worker has no
 * request, so it cannot re-derive any of them.
 *
 * That mattered more than it looks. `applyTenantFilter` treats
 * `visibleOwnerIds === undefined` as "no owner predicate", which is correct for
 * an admin and catastrophic for a worker: the export cursor came back with every
 * task in the tenant regardless of who asked. A user whose list view showed three
 * rows could press Export and receive five hundred. The same code path had
 * already learned this lesson for field-level masking — `userGroupId` above is
 * snapshotted for exactly this reason, with exactly this justification in its
 * docblock — and stopped one layer short of row-level scope.
 *
 * `null` and `[]` are meaningfully different here and must survive the round
 * trip through JSON: `null` means "admin, sees everything" and `[]` means "sees
 * nothing". Collapsing either into `undefined` reopens the hole.
 */
export interface ExportScopeSnapshot {
  visibleOwnerIds: string[] | null;
  visibleOrgUnitIds: string[] | null;
  dataVisibilityByModule: Record<
    string,
    { ownerIds: string[] | null; orgUnitIds: string[] | null }
  > | null;
  includeUnownedInScope: boolean;
  abacResourceFilter: {
    resource?: string;
    filter?: Record<string, unknown> | null;
  } | null;
}

/**
 * Standard BullMQ job payload for ALL export jobs. Module-specific processors
 * may extend this with extra snapshotted settings.
 */
export interface BaseExportJobData extends TenantJobData {
  tenantId: string;
  userId?: string;
  /**
   * Snapshot of the requester's masking group at enqueue time. The worker has
   * no HTTP context, so it cannot re-derive this. Falls back to 'default'.
   */
  userGroupId?: string;
  /**
   * Snapshot of the requester's row-level visibility. See
   * {@link ExportScopeSnapshot} — without it the export reads wider than the
   * request that asked for it.
   */
  scope?: ExportScopeSnapshot;
  /** Output format. Phase 1 supports 'csv'; 'xlsx' lands in Phase 2. */
  format: ExportFormat;
  /** Selected column keys (the `path` of each column). Omit = all columns. */
  columns?: string[];
  /** Typed filter describing what to export. */
  filter: ExportFilter;
  /** Original filename hint (without extension). */
  fileName?: string;
}
